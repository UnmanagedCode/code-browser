import { useEffect, useRef, type RefObject } from 'react';
import { createGestureTracker } from '../input/gestures';
import { isPasteChord, keyMessage, modifiersOf } from '../input/keys';
import { mapPoint, type FrameGeometry } from '../input/mapPoint';
import { attachTextInput } from '../input/textInput';
import type { InputMessage } from '../protocol';
import type { ViewerSocket } from '../socket';

interface Props {
  socket: ViewerSocket;
  hasControl: boolean;
  // The keyboard sink; the viewer focuses and blurs it from its Keyboard button.
  keyboardRef: RefObject<HTMLTextAreaElement | null>;
  onKeyboardActive(active: boolean): void;
  onTake(): void;
  // The id of this tabpanel, and of the tab that labels it. `labelled` is false when no rendered tab owns the panel.
  panelId: string;
  labelled: boolean;
}

const BUTTONS = ['left', 'middle', 'right'] as const;
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 5;
const LINE_PX = 16;
const PAGE_PX = 800;

// The canvas shows the screencast; pointer and keyboard input become input messages only while the
// viewer holds control. Frames are acked after drawing, which paces the backend.
export function Screen({ socket, hasControl, keyboardRef, onKeyboardActive, onTake, panelId, labelled }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(onKeyboardActive);
  activeRef.current = onKeyboardActive;
  const geometry = useRef<FrameGeometry | null>(null);
  const controlRef = useRef(hasControl);
  controlRef.current = hasControl;

  const sendInput = (m: InputMessage) => { if (controlRef.current) socket.send({ msg: 'input', ...m }); };

  // Draw frames, then ack.
  useEffect(() => socket.onFrame((header, jpeg) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' })).then((bitmap) => {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      bitmap.close();
      geometry.current = { imageWidth: bitmap.width || header.width, imageHeight: bitmap.height || header.height, meta: header.meta };
      canvas.dataset.frameSeq = String(header.seq);
      canvas.dataset.deviceWidth = String(header.meta.deviceWidth);
      canvas.dataset.deviceHeight = String(header.meta.deviceHeight);
      socket.send({ msg: 'ack', seq: header.seq });
    }, (err) => {
      console.error('code-browser: could not decode a frame', err);
      socket.send({ msg: 'ack', seq: header.seq });
    });
  }), [socket]);

  // Size follows the element; the backend sizes its screencast to the largest viewer.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      socket.setViewport(Math.round(r.width * dpr), Math.round(r.height * dpr));
    };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(report, 150); });
    ro?.observe(canvas);
    return () => { ro?.disconnect(); clearTimeout(timer); };
  }, [socket]);

  const toPage = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const g = geometry.current;
    if (!canvas || !g) return null;
    return mapPoint(clientX, clientY, canvas.getBoundingClientRect(), g);
  };

  // Pointer input: mouse and pen become mouse messages; touch goes through the gesture tracker.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let lastDown = { t: 0, x: 0, y: 0, count: 0 };
    let pendingMove: PointerEvent | null = null;
    let raf = 0;

    const gestures = createGestureTracker((g) => {
      const p = toPage(g.x, g.y);
      if (!p) return;
      if (g.type === 'tap') {
        sendInput({ kind: 'mouse', action: 'move', x: p.x, y: p.y });
        sendInput({ kind: 'mouse', action: 'down', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
        sendInput({ kind: 'mouse', action: 'up', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
      } else {
        sendInput({ kind: 'wheel', x: p.x, y: p.y, deltaX: g.deltaX, deltaY: g.deltaY });
      }
    });

    const onDown = (e: PointerEvent) => {
      if (!controlRef.current) return;
      canvas.setPointerCapture?.(e.pointerId);
      if (e.pointerType === 'touch') { gestures.down(e.pointerId, e.clientX, e.clientY, e.timeStamp); return; }
      keyboardRef.current?.focus({ preventScroll: true });
      const p = toPage(e.clientX, e.clientY);
      if (!p) return;
      const near = Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) <= MULTI_CLICK_PX;
      const count = e.timeStamp - lastDown.t <= MULTI_CLICK_MS && near ? Math.min(3, lastDown.count + 1) : 1;
      lastDown = { t: e.timeStamp, x: e.clientX, y: e.clientY, count };
      sendInput({ kind: 'mouse', action: 'down', x: p.x, y: p.y, button: BUTTONS[e.button] ?? 'left', buttons: e.buttons, clickCount: count, modifiers: modifiersOf(e) });
    };
    const flushMove = () => {
      raf = 0;
      const e = pendingMove;
      pendingMove = null;
      if (!e) return;
      const p = toPage(e.clientX, e.clientY);
      if (p) sendInput({ kind: 'mouse', action: 'move', x: p.x, y: p.y, button: e.buttons ? 'left' : 'none', buttons: e.buttons, modifiers: modifiersOf(e) });
    };
    const onMove = (e: PointerEvent) => {
      if (!controlRef.current) return;
      if (e.pointerType === 'touch') { gestures.move(e.pointerId, e.clientX, e.clientY); return; }
      pendingMove = e; // coalesced to one message per animation frame
      if (!raf) raf = requestAnimationFrame(flushMove);
    };
    const onUp = (e: PointerEvent) => {
      if (!controlRef.current) return;
      if (e.pointerType === 'touch') { gestures.up(e.pointerId, e.clientX, e.clientY, e.timeStamp); return; }
      const p = toPage(e.clientX, e.clientY);
      if (p) sendInput({ kind: 'mouse', action: 'up', x: p.x, y: p.y, button: BUTTONS[e.button] ?? 'left', buttons: e.buttons, clickCount: lastDown.count, modifiers: modifiersOf(e) });
    };
    const onCancel = (e: PointerEvent) => { if (e.pointerType === 'touch') gestures.cancel(e.pointerId); };
    const onWheel = (e: WheelEvent) => {
      if (!controlRef.current) return;
      e.preventDefault();
      const p = toPage(e.clientX, e.clientY);
      if (!p) return;
      const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? PAGE_PX : 1;
      sendInput({ kind: 'wheel', x: p.x, y: p.y, deltaX: e.deltaX * unit, deltaY: e.deltaY * unit, modifiers: modifiersOf(e) });
    };
    const noMenu = (e: Event) => e.preventDefault();
    // A press on the (unfocusable) canvas would otherwise move focus off the keyboard sink.
    const keepFocus = (e: MouseEvent) => e.preventDefault();

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', noMenu);
    canvas.addEventListener('mousedown', keepFocus);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', noMenu);
      canvas.removeEventListener('mousedown', keepFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers read refs; the socket is stable
  }, [socket]);

  // Keyboard: the hidden textarea takes focus on click (mouse) or via the viewer's Keyboard button (touch).
  useEffect(() => {
    const ta = keyboardRef.current;
    if (!ta) return undefined;
    const onFocus = () => activeRef.current(true);
    const onBlur = () => activeRef.current(false);
    const onKey = (action: 'down' | 'up') => (e: KeyboardEvent) => {
      if (!controlRef.current || isPasteChord(e)) return;
      const m = keyMessage(e, action);
      if (!m) return;
      e.preventDefault();
      sendInput(m);
    };
    const down = onKey('down');
    const up = onKey('up');
    ta.addEventListener('keydown', down);
    ta.addEventListener('keyup', up);
    ta.addEventListener('focus', onFocus);
    ta.addEventListener('blur', onBlur);
    const detach = attachTextInput(ta, sendInput);
    return () => {
      ta.removeEventListener('keydown', down);
      ta.removeEventListener('keyup', up);
      ta.removeEventListener('focus', onFocus);
      ta.removeEventListener('blur', onBlur);
      activeRef.current(false); // a removed sink fires no blur
      detach();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers read refs; the socket is stable
  }, [socket]);

  return (
    <div className="screen" {...(labelled ? { role: 'tabpanel', id: panelId, 'aria-labelledby': `${panelId}-tab` } : {})} data-control={hasControl}>
      <canvas ref={canvasRef} className="screen-canvas" role="img" aria-label="Live view of the page" />
      <textarea ref={keyboardRef} className="keyboard-sink" aria-label="Keyboard input" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      {!hasControl && <button type="button" className="screen-hint" data-variant="primary" data-size="sm" onClick={onTake}>Take control to interact</button>}
    </div>
  );
}
