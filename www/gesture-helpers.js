// gesture-helpers.js v73 - unified gesture support (pinch/pan/dblclick/wheel)
// v73: expose zoomAt on target element for external double-tap handling
//      disable internal touchend double-tap (overlay handles it now)
(function(window) {
  'use strict';

  function enableGestures(target, opts) {
    opts = opts || {};
    var o = {
      minScale: opts.minScale || 1,
      maxScale: opts.maxScale || 5,
      doubleTapScale: opts.doubleTapScale || 2.5
    };

    var state = {
      scale: 1, tx: 0, ty: 0,
      panStart: null, pinchStart: null
    };

    function applyTransform(transition) {
      target.style.transition = transition ? 'transform .25s ease-out' : '';
      target.style.transformOrigin = 'center center';
      target.style.transform = 'translate(' + state.tx + 'px,' + state.ty + 'px) scale(' + state.scale + ')';
    }

    function clampTranslate() {
      var parent = target.parentElement;
      if (!parent) return;
      var pw = parent.clientWidth, ph = parent.clientHeight;
      var fitW = target.clientWidth, fitH = target.clientHeight;
      var dispW = fitW * state.scale;
      var dispH = fitH * state.scale;
      var maxX = Math.max(0, (dispW - pw) / 2);
      var maxY = Math.max(0, (dispH - ph) / 2);
      state.tx = Math.max(-maxX, Math.min(state.tx, maxX));
      state.ty = Math.max(-maxY, Math.min(state.ty, maxY));
    }

    // v73: 统一缩放函数，mx/my 为容器坐标，s1=0 表示 toggle
    function zoomAt(mx, my, s1) {
      var parent = target.parentElement;
      if (!parent) return;
      var pw = parent.clientWidth, ph = parent.clientHeight;
      var s0 = state.scale;
      if (s1 === 0) {
        // toggle: 缩放状态 > 1.5 则复位，否则放大到 doubleTapScale
        s1 = (s0 > 1.5) ? o.minScale : o.doubleTapScale;
      }
      s1 = Math.max(o.minScale, Math.min(s1, o.maxScale));
      if (Math.abs(s1 - s0) < 0.001) return;
      var newTx = mx - pw/2 - (mx - pw/2 - state.tx) * s1 / s0;
      var newTy = my - ph/2 - (my - ph/2 - state.ty) * s1 / s0;
      state.scale = s1;
      state.tx = newTx;
      state.ty = newTy;
      clampTranslate();
      applyTransform(true);
    }

    function reset() {
      state.scale = 1; state.tx = 0; state.ty = 0;
      clampTranslate();
      applyTransform(true);
    }

    function onTouchStart(e) {
      if (e.touches.length === 2) {
        e.preventDefault();
        var t1 = e.touches[0], t2 = e.touches[1];
        var parent = target.parentElement;
        var rect = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
        state.pinchStart = {
          dist: Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY),
          midX: (t1.clientX + t2.clientX) / 2,
          midY: (t1.clientY + t2.clientY) / 2,
          lastDist: Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY),
          lastMidX: (t1.clientX + t2.clientX) / 2 - rect.left,
          lastMidY: (t1.clientY + t2.clientY) / 2 - rect.top
        };
        state.panStart = null;
      } else if (e.touches.length === 1 && state.scale > 1) {
        var t = e.touches[0];
        var p = target.parentElement;
        var r = p ? p.getBoundingClientRect() : { left: 0, top: 0 };
        state.panStart = { x: t.clientX - r.left - state.tx, y: t.clientY - r.top - state.ty };
      }
    }

    function onTouchMove(e) {
      if (state.pinchStart && e.touches.length === 2) {
        e.preventDefault();
        var t1 = e.touches[0], t2 = e.touches[1];
        var parent = target.parentElement;
        if (!parent) return;
        var rect = parent.getBoundingClientRect();
        var pw = parent.clientWidth, ph = parent.clientHeight;

        var newDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        var curMidX = (t1.clientX + t2.clientX) / 2 - rect.left;
        var curMidY = (t1.clientY + t2.clientY) / 2 - rect.top;

        if (Math.abs(newDist - state.pinchStart.lastDist) < 1) return;

        state.tx += curMidX - state.pinchStart.lastMidX;
        state.ty += curMidY - state.pinchStart.lastMidY;

        var scaleFactor = newDist / state.pinchStart.lastDist;
        var newScale = Math.max(o.minScale, Math.min(state.scale * scaleFactor, o.maxScale));
        if (Math.abs(newScale - state.scale) > 0.001) {
          var offsetX = curMidX - (pw/2 + state.tx);
          var offsetY = curMidY - (ph/2 + state.ty);
          state.tx = curMidX - pw/2 - offsetX * (newScale / state.scale);
          state.ty = curMidY - ph/2 - offsetY * (newScale / state.scale);
          state.scale = newScale;
        }

        state.pinchStart.lastDist = newDist;
        state.pinchStart.lastMidX = curMidX;
        state.pinchStart.lastMidY = curMidY;

        clampTranslate();
        applyTransform(false);
      } else if (state.panStart && e.touches.length === 1 && state.scale > 1) {
        e.preventDefault();
        var t = e.touches[0];
        var p = target.parentElement;
        var r = p ? p.getBoundingClientRect() : { left: 0, top: 0 };
        state.tx = t.clientX - r.left - state.panStart.x;
        state.ty = t.clientY - r.top - state.panStart.y;
        clampTranslate();
        applyTransform(false);
      }
    }

    function onTouchEnd(e) {
      // v73: 不再在 touchend 检测双击（由 overlay 统一处理）
      if (state.pinchStart && e.touches.length < 2) {
        state.pinchStart = null;
        if (state.scale < 1.05 && state.scale > 0.95) {
          reset();
        }
      }
      if (e.touches.length === 0) {
        state.panStart = null;
      }
    }

    function onDblClick(e) {
      e.preventDefault();
      e.stopPropagation();
      var parent = target.parentElement;
      var rect = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      zoomAt(mx, my, 0);  // toggle
    }

    function onWheel(e) {
      e.preventDefault();
      var parent = target.parentElement;
      var rect = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      var delta = e.deltaY > 0 ? 0.9 : 1.1;
      zoomAt(mx, my, state.scale * delta);
    }

    target.addEventListener('touchstart', onTouchStart, { passive: false });
    target.addEventListener('touchmove', onTouchMove, { passive: false });
    target.addEventListener('touchend', onTouchEnd);
    target.addEventListener('touchcancel', onTouchEnd);
    target.addEventListener('dblclick', onDblClick);
    target.addEventListener('wheel', onWheel, { passive: false });

    // v73: 暴露 zoomAt/reset 供外部调用（overlay 的双击处理用）
    target._gestureZoomAt = zoomAt;
    target._gestureReset = reset;

    return function destroy() {
      target.removeEventListener('touchstart', onTouchStart);
      target.removeEventListener('touchmove', onTouchMove);
      target.removeEventListener('touchend', onTouchEnd);
      target.removeEventListener('touchcancel', onTouchEnd);
      target.removeEventListener('dblclick', onDblClick);
      target.removeEventListener('wheel', onWheel);
      delete target._gestureZoomAt;
      delete target._gestureReset;
    };
  }

  window.GestureHelpers = { enableGestures: enableGestures };
})(window);
