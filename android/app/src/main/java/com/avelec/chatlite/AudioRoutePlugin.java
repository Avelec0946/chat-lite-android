package com.avelec.chatlite;

import android.bluetooth.BluetoothAdapter;
import android.content.Context;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * AudioRoute —— 把「当前音频输出走到了哪个设备」暴露给 JS。
 *
 * 背景（v126 语音通话）：外放和耳机需要两套调参预设。外放时扬声器声音会被
 * 麦克风收回去，回声/自激更严重，需要更大的防自激窗口；耳机（有线/蓝牙）下
 * 不存在这条回授路径，用另一套更灵敏的参数。JS 侧（voice.js）每通电话开始时
 * 调 getRoute() 拿一次初始状态，并监听 routeChange 做热切换。
 *
 * 接口契约（JS 侧已按此实现，不要改字段名）：
 *   getRoute() -> { type: 'headset'|'bluetooth'|'speaker'|'earpiece', name: string }
 *   addListener('routeChange', cb) -> 同上对象
 *
 * 判定规则（按优先顺序，全部来自 AudioManager.getDevices(GET_DEVICES_OUTPUTS)）：
 *   1. TYPE_WIRED_HEADPHONES / TYPE_WIRED_HEADSET  -> headset（name 优先 productName）
 *   2. TYPE_BLUETOOTH_A2DP / TYPE_BLUETOOTH_SCO    -> bluetooth（name 优先 BluetoothAdapter 设备名）
 *   3. TYPE_USB_HEADSET                            -> headset
 *   4. 无外接设备：
 *        - 系统在「外放模式」关闭且硬件真有听筒（TYPE_BUILTIN_EARPIECE）-> earpiece
 *        - 其余 -> speaker
 *      说明：契约写的是「isSpeakerphoneOn()==false 且无外接设备 -> earpiece」。
 *      这里额外加了一条「硬件必须真有听筒」的判定，因为平板（本项目目标设备
 *      华为平板 M6 / Android 10）根本没有听筒硬件，而 isSpeakerphoneOn() 在
 *      平板/不外放通话时同样可能为 false；不加这条会把平板误报成 earpiece，
 *      JS 就会选耳机预设，正好把用户想要的「外放预设」丢掉。手机上有听筒，
 *      行为与契约完全一致。
 *
 * 兼容性：
 *   - AudioManager.getDevices / AudioDeviceCallback 需要 API 23（Android 6）。
 *     minSdk 是 22，API 22 上退回已废弃的 isWiredHeadsetOn/isBluetoothA2dpOn/
 *     isSpeakerphoneOn 查询，getRoute 仍可用，但没有 routeChange 事件。
 *   - Android 12+（API 31）读 BluetoothAdapter.getName() 需要 BLUETOOTH_CONNECT
 *     运行时权限。本插件【不】申请任何权限（manifest 也不加），读不到就用兜底
 *     名字「蓝牙设备」/ 设备 productName，绝不因为权限抛异常或崩溃。
 *
 * 健壮性硬要求：任何一步失败都返回兜底对象 { type:'speaker', name:'外放' }，
 * 绝不让异常逃逸到 JS（调用方是通话主链路，一个未捕获异常会直接断掉语音）。
 */
@CapacitorPlugin(name = "AudioRoute")
public class AudioRoutePlugin extends Plugin {

    private static final String TAG = "AudioRoute";

    public static final String TYPE_HEADSET = "headset";
    public static final String TYPE_BLUETOOTH = "bluetooth";
    public static final String TYPE_SPEAKER = "speaker";
    public static final String TYPE_EARPIECE = "earpiece";

    /** 设备插拔回调；API 23 以下不注册（为 null） */
    private AudioDeviceCallback deviceCallback;
    /** 回调统一在主线程处理，notifyListeners 必须在主线程调 */
    private Handler mainHandler;
    /** 上一次已经通知给 JS 的 route 指纹，用于去掉重复事件（A2DP 重连时系统会连发多条） */
    private volatile String lastNotifiedKey;

    @Override
    public void load() {
        try {
            mainHandler = new Handler(Looper.getMainLooper());
            registerDeviceCallback();
            // 记下初始路由：JS 先 getRoute() 再 addListener 时不会立刻收到一条重复事件，
            // 只有真的发生变化才通知。
            lastNotifiedKey = routeKey(safeComputeRoute());
        } catch (Throwable t) {
            // 监听装不上不影响 getRoute 主动查询，通话主链路继续
            Log.w(TAG, "load 初始化失败（getRoute 仍可用，只是没有 routeChange 事件）", t);
        }
    }

    /**
     * 当前音频路由。
     * JS: const { type, name } = await AudioRoute.getRoute()
     */
    @PluginMethod
    public void getRoute(PluginCall call) {
        JSObject route;
        try {
            route = safeComputeRoute();
        } catch (Throwable t) {
            Log.e(TAG, "getRoute 计算异常，返回兜底对象", t);
            route = fallbackRoute();
        }
        lastNotifiedKey = routeKey(route);
        try {
            call.resolve(route);
        } catch (Throwable t) {
            // resolve 本身失败（call 已失效等）也只能吞掉：绝不能抛给 JS
            Log.w(TAG, "getRoute resolve 失败", t);
            try {
                call.resolve(fallbackRoute());
            } catch (Throwable ignored) {
                // 已失效，忽略
            }
        }
    }

    // ---------------------------------------------------------------------
    // 设备回调
    // ---------------------------------------------------------------------

    private void registerDeviceCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            Log.i(TAG, "API " + Build.VERSION.SDK_INT + "：无 AudioDeviceCallback，routeChange 事件不可用，仅支持 getRoute 主动查询");
            return;
        }
        AudioManager am = getAudioManager();
        if (am == null) {
            Log.w(TAG, "AudioManager 为空，跳过 routeChange 监听");
            return;
        }
        deviceCallback = new AudioDeviceCallback() {
            @Override
            public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
                handleRouteMaybeChanged("added");
            }

            @Override
            public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
                handleRouteMaybeChanged("removed");
            }
        };
        am.registerAudioDeviceCallback(deviceCallback, mainHandler);
        Log.i(TAG, "已注册 AudioDeviceCallback，routeChange 监听生效");
    }

    private void unregisterDeviceCallback() {
        if (deviceCallback == null) {
            return;
        }
        AudioManager am = getAudioManager();
        if (am != null) {
            try {
                am.unregisterAudioDeviceCallback(deviceCallback);
            } catch (Throwable t) {
                Log.w(TAG, "反注册 AudioDeviceCallback 失败（忽略）", t);
            }
        }
        deviceCallback = null;
    }

    /**
     * 插拔后重算路由并通知 JS。回调可能来自任意线程（这里注册在主线程 Handler，
     * 实际是主线程），仍然 post 一次保证 notifyListeners 在主线程执行。
     */
    private void handleRouteMaybeChanged(String reason) {
        final Handler handler = mainHandler;
        if (handler == null) {
            return;
        }
        handler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    JSObject route = safeComputeRoute();
                    String key = routeKey(route);
                    if (key.equals(lastNotifiedKey)) {
                        return;
                    }
                    lastNotifiedKey = key;
                    notifyListeners("routeChange", route);
                } catch (Throwable t) {
                    // 通知失败只记日志：这是通话中的附加信息，不能影响主链路
                    Log.w(TAG, "routeChange 通知失败（忽略）", t);
                }
            }
        });
    }

    // ---------------------------------------------------------------------
    // 路由判定
    // ---------------------------------------------------------------------

    private JSObject safeComputeRoute() {
        try {
            return computeRoute();
        } catch (Throwable t) {
            Log.w(TAG, "computeRoute 异常，返回兜底对象", t);
            return fallbackRoute();
        }
    }

    private JSObject computeRoute() {
        AudioManager am = getAudioManager();
        if (am == null) {
            return buildRoute(TYPE_SPEAKER, "外放");
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            AudioDeviceInfo[] devices = null;
            try {
                devices = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
            } catch (Throwable t) {
                Log.w(TAG, "getDevices 失败，退回旧版布尔查询", t);
            }
            if (devices != null) {
                boolean wired = false;
                boolean bluetooth = false;
                boolean usb = false;
                boolean builtinEarpiece = false;
                String wiredProduct = null;
                String bluetoothProduct = null;
                String usbProduct = null;

                for (AudioDeviceInfo device : devices) {
                    if (device == null) {
                        continue;
                    }
                    int type;
                    try {
                        type = device.getType();
                    } catch (Throwable t) {
                        continue;
                    }
                    String product = productNameOf(device);
                    if (type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                            || type == AudioDeviceInfo.TYPE_WIRED_HEADSET) {
                        if (!wired) {
                            wired = true;
                            wiredProduct = product;
                        }
                    } else if (type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
                            || type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) {
                        if (!bluetooth) {
                            bluetooth = true;
                            bluetoothProduct = product;
                        }
                    } else if (type == AudioDeviceInfo.TYPE_USB_HEADSET) {
                        if (!usb) {
                            usb = true;
                            usbProduct = product;
                        }
                    } else if (type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) {
                        builtinEarpiece = true;
                    }
                }

                if (wired) {
                    return buildRoute(TYPE_HEADSET, pickName(wiredProduct, "有线耳机"));
                }
                if (bluetooth) {
                    return buildRoute(TYPE_BLUETOOTH, bluetoothDisplayName(bluetoothProduct));
                }
                if (usb) {
                    return buildRoute(TYPE_HEADSET, pickName(usbProduct, "有线耳机"));
                }

                // 无外接设备：只有「系统未开外放」且「硬件真有听筒」才算听筒
                boolean speakerphoneOn;
                try {
                    speakerphoneOn = am.isSpeakerphoneOn();
                } catch (Throwable t) {
                    speakerphoneOn = true; // 读不到就当外放，宁可走外放预设也不要误判成耳机预设
                }
                if (!speakerphoneOn && builtinEarpiece) {
                    return buildRoute(TYPE_EARPIECE, "听筒");
                }
                return buildRoute(TYPE_SPEAKER, "外放");
            }
        }

        // API 22（minSdk）或 getDevices 不可用：退回已废弃的布尔查询
        return legacyRoute(am);
    }

    /** API 22 兜底：没有 getDevices，只能用 5.x 的布尔接口 */
    @SuppressWarnings("deprecation")
    private JSObject legacyRoute(AudioManager am) {
        try {
            if (am.isWiredHeadsetOn()) {
                return buildRoute(TYPE_HEADSET, "有线耳机");
            }
            if (am.isBluetoothA2dpOn()) {
                return buildRoute(TYPE_BLUETOOTH, bluetoothDisplayName(null));
            }
        } catch (Throwable t) {
            Log.w(TAG, "旧版路由查询失败", t);
        }
        try {
            if (!am.isSpeakerphoneOn()) {
                return buildRoute(TYPE_EARPIECE, "听筒");
            }
        } catch (Throwable t) {
            // 读不到就当外放
        }
        return buildRoute(TYPE_SPEAKER, "外放");
    }

    /**
     * 蓝牙显示名：按契约优先 BluetoothAdapter 里的设备名，退而用 productName，
     * 再退「蓝牙设备」。
     * Android 12+ 需要 BLUETOOTH_CONNECT，本插件不申请权限，读不到就走兜底。
     */
    private String bluetoothDisplayName(String productName) {
        String adapterName = null;
        try {
            BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
            if (adapter != null) {
                adapterName = adapter.getName();
            }
        } catch (Throwable t) {
            // SecurityException（Android 12+ 缺 BLUETOOTH_CONNECT）/ 适配器异常等
            Log.d(TAG, "读蓝牙设备名失败，使用兜底名字", t);
        }
        if (adapterName != null && adapterName.trim().length() > 0) {
            return adapterName.trim();
        }
        return pickName(productName, "蓝牙设备");
    }

    private String productNameOf(AudioDeviceInfo device) {
        try {
            CharSequence product = device.getProductName();
            if (product != null) {
                String name = product.toString().trim();
                if (name.length() > 0) {
                    return name;
                }
            }
        } catch (Throwable t) {
            // 个别 ROM 的 getProductName 会抛，忽略
        }
        return null;
    }

    private String pickName(String product, String chineseFallback) {
        if (product != null) {
            String trimmed = product.trim();
            if (trimmed.length() > 0) {
                return trimmed;
            }
        }
        return chineseFallback;
    }

    private AudioManager getAudioManager() {
        try {
            Context ctx = getContext();
            if (ctx == null) {
                ctx = getActivity();
            }
            if (ctx == null) {
                return null;
            }
            return (AudioManager) ctx.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
        } catch (Throwable t) {
            Log.w(TAG, "取 AudioManager 失败", t);
            return null;
        }
    }

    private JSObject buildRoute(String type, String name) {
        JSObject ret = new JSObject();
        ret.put("type", type);
        ret.put("name", name);
        return ret;
    }

    private JSObject fallbackRoute() {
        return buildRoute(TYPE_SPEAKER, "外放");
    }

    private String routeKey(JSObject route) {
        try {
            String type = route.optString("type", TYPE_SPEAKER);
            String name = route.optString("name", "外放");
            return type + "|" + name;
        } catch (Throwable t) {
            return TYPE_SPEAKER + "|外放";
        }
    }

    @Override
    protected void handleOnDestroy() {
        // 必须反注册：AudioManager 持有 callback 强引用，不摘会拖住插件实例和 Activity
        unregisterDeviceCallback();
        mainHandler = null;
        lastNotifiedKey = null;
        super.handleOnDestroy();
    }
}
