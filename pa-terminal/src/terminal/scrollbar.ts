import type { Terminal } from "@xterm/xterm";

/** Fixed-size thumb with an absolute position in the terminal's scrollback. */
export class PaneScrollbar {
  private readonly rail = document.createElement("div");
  private readonly thumb = document.createElement("div");
  private readonly subscriptions: { dispose(): void }[];
  private frame = 0;
  private disposed = false;
  private drag: { id: number; offset: number } | undefined;

  constructor(private readonly term: Terminal) {
    this.rail.className = "pane-scrollbar";
    this.rail.tabIndex = 0;
    this.rail.setAttribute("role", "scrollbar");
    this.rail.setAttribute("aria-label", "Terminal scrollback");
    this.rail.setAttribute("aria-orientation", "vertical");
    this.rail.setAttribute("aria-valuemin", "0");
    this.thumb.className = "pane-scroll-thumb";
    this.rail.append(this.thumb);
    // Keep native wheel handling in xterm, including application mouse reporting.
    term.element!.append(this.rail);
    this.subscriptions = [
      term.onScroll(() => this.schedule()),
      term.onResize(() => this.schedule()),
      term.onWriteParsed(() => this.schedule()),
      term.buffer.onBufferChange(() => { this.finishDrag(); this.schedule(); }),
    ];
    // Wheel-driven viewport scrolling can suppress xterm's onScroll event.
    const viewport = term.element!.querySelector(".xterm-viewport")!;
    const onViewportScroll = () => this.schedule();
    viewport.addEventListener("scroll", onViewportScroll);
    this.subscriptions.push({ dispose: () => viewport.removeEventListener("scroll", onViewportScroll) });
    // Don't let xterm / Pane focus restore the pre-drag position.
    for (const type of ["mousedown", "mousemove", "mouseup", "click"]) {
      this.rail.addEventListener(type, event => event.stopPropagation());
    }
    this.rail.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (!this.term.buffer.active.baseY) return;
      const thumb = this.thumb.getBoundingClientRect();
      this.drag = {
        id: event.pointerId,
        offset: event.target === this.thumb ? event.clientY - thumb.top : thumb.height / 2,
      };
      this.rail.setPointerCapture(event.pointerId);
      this.rail.classList.add("is-dragging");
      this.move(event.clientY);
    });
    this.rail.addEventListener("pointermove", event => {
      if (this.drag?.id !== event.pointerId) return;
      event.stopPropagation();
      this.move(event.clientY);
    });
    const finish = (event: PointerEvent) => {
      if (this.drag?.id !== event.pointerId) return;
      if (event.type === "pointerup") this.move(event.clientY);
      this.finishDrag();
    };
    this.rail.addEventListener("pointerup", finish);
    this.rail.addEventListener("pointercancel", finish);
    this.rail.addEventListener("lostpointercapture", finish);
    this.rail.addEventListener("keydown", event => {
      // Only the focused rail handles these; terminal keyboard input is unchanged.
      event.stopPropagation();
      const buffer = term.buffer.active;
      const targets: Record<string, number> = {
        ArrowUp: buffer.viewportY - 1, ArrowDown: buffer.viewportY + 1,
        PageUp: buffer.viewportY - term.rows, PageDown: buffer.viewportY + term.rows,
        Home: 0, End: buffer.baseY,
      };
      if (!(event.key in targets)) return;
      event.preventDefault();
      term.scrollToLine(targets[event.key]);
      this.sync();
    });
    this.schedule();
  }

  schedule() {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.sync();
    });
  }

  private sync() {
    const buffer = this.term.buffer.active;
    const range = Math.max(0, this.rail.clientHeight - this.thumb.offsetHeight);
    const position = buffer.baseY > 0 ? buffer.viewportY / buffer.baseY : 1;
    this.thumb.style.transform = `translateY(${Math.round(range * position)}px)`;
    this.rail.setAttribute("aria-valuemax", String(buffer.baseY));
    this.rail.setAttribute("aria-valuenow", String(buffer.viewportY));
    this.rail.setAttribute("aria-disabled", String(buffer.baseY === 0));
    // An unsupported full-screen application owns its history; don't invent a
    // position or send synthetic wheel/key input while pretending to seek it.
    if (buffer.type === "alternate") {
      this.rail.setAttribute("aria-valuetext", "Application-owned screen; terminal scrollback unavailable");
    } else {
      this.rail.removeAttribute("aria-valuetext");
    }
  }

  private move(clientY: number) {
    if (!this.drag) return;
    const range = this.rail.clientHeight - this.thumb.offsetHeight;
    if (range <= 0) return;
    const top = clientY - this.rail.getBoundingClientRect().top - this.drag.offset;
    const fraction = Math.max(0, Math.min(1, top / range));
    this.term.scrollToLine(Math.round(fraction * this.term.buffer.active.baseY));
    this.sync();
  }

  private finishDrag() {
    const drag = this.drag;
    this.drag = undefined;
    this.rail.classList.remove("is-dragging");
    if (drag && this.rail.hasPointerCapture(drag.id)) this.rail.releasePointerCapture(drag.id);
    this.sync();
  }

  dispose() {
    this.disposed = true;
    this.finishDrag();
    if (this.frame) cancelAnimationFrame(this.frame);
    for (const subscription of this.subscriptions) subscription.dispose();
    this.rail.remove();
  }
}
