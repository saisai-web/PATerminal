const DRAG_THRESHOLD_PX = 4;

type SelectionSnapshot = {
  anchorNode: Node | null;
  anchorOffset: number;
  focusNode: Node | null;
  focusOffset: number;
  text: string;
};

function selectionSnapshot(): SelectionSnapshot {
  const selection = window.getSelection();
  return {
    anchorNode: selection?.anchorNode ?? null,
    anchorOffset: selection?.anchorOffset ?? 0,
    focusNode: selection?.focusNode ?? null,
    focusOffset: selection?.focusOffset ?? 0,
    text: selection?.isCollapsed ? "" : (selection?.toString() ?? ""),
  };
}

function selectionTouches(container: HTMLElement, selection: SelectionSnapshot): boolean {
  if (!selection.text) return false;
  return Boolean(
    (selection.anchorNode && container.contains(selection.anchorNode))
      || (selection.focusNode && container.contains(selection.focusNode)),
  );
}

function sameSelection(a: SelectionSnapshot, b: SelectionSnapshot): boolean {
  return a.anchorNode === b.anchorNode
    && a.anchorOffset === b.anchorOffset
    && a.focusNode === b.focusNode
    && a.focusOffset === b.focusOffset
    && a.text === b.text;
}

/**
 * Tracks whether the current primary-pointer gesture selected text in `container`.
 * The returned function consumes that one gesture, so an old selection cannot block
 * every later click on the same control.
 */
export function trackSelectionDrag(container: HTMLElement): () => boolean {
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let dragged = false;
  let selectionAtStart = selectionSnapshot();

  const reset = () => {
    pointerId = null;
    dragged = false;
  };

  container.addEventListener("pointerdown", (event) => {
    reset();
    if (event.button !== 0) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    selectionAtStart = selectionSnapshot();
  });
  container.addEventListener("pointermove", (event) => {
    if (pointerId !== event.pointerId || dragged || (event.buttons & 1) === 0) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    dragged = dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX;
  });
  container.addEventListener("pointercancel", reset);

  return () => {
    const selectionNow = selectionSnapshot();
    const selectedByThisDrag = dragged
      && selectionTouches(container, selectionNow)
      && !sameSelection(selectionAtStart, selectionNow);
    reset();
    return selectedByThisDrag;
  };
}
