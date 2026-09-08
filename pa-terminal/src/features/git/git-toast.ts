import { t } from "../../i18n";

// Outside the Git strip so completion remains visible after a dialog or session closes.
const toast = document.createElement("div");
toast.id = "git-toast";
toast.hidden = true;
const icon = document.createElement("span");
icon.className = "git-toast-icon";
icon.setAttribute("aria-hidden", "true");
const content = document.createElement("div");
content.className = "git-toast-content";
content.setAttribute("role", "status");
content.setAttribute("aria-live", "polite");
content.setAttribute("aria-atomic", "true");
const title = document.createElement("strong");
const detail = document.createElement("div");
detail.className = "git-toast-detail";
content.append(title, detail);
const close = document.createElement("button");
close.type = "button";
close.textContent = "×";
toast.append(icon, content, close);
document.body.append(toast);
let timer = 0;
let kind: "ok" | "err" | "busy" = "busy";

function dismiss(): void {
  window.clearTimeout(timer);
  toast.hidden = true;
}
function scheduleDismiss(): void {
  window.clearTimeout(timer);
  if (kind === "ok" && !toast.matches(":hover") && !toast.contains(document.activeElement)) {
    timer = window.setTimeout(dismiss, 8000);
  }
}
close.onclick = dismiss;
toast.addEventListener("mouseenter", () => window.clearTimeout(timer));
toast.addEventListener("mouseleave", scheduleDismiss);
toast.addEventListener("focusin", () => window.clearTimeout(timer));
toast.addEventListener("focusout", scheduleDismiss);
toast.addEventListener("keydown", (event) => {
  event.stopPropagation();
  if (event.key === "Escape") dismiss();
});

export function showGitToast(text: string, nextKind: typeof kind): void {
  dismiss();
  kind = nextKind;
  // Clear the previous result as soon as the next operation starts.
  if (kind === "busy") return;
  toast.dataset.kind = kind;
  icon.textContent = kind === "ok" ? "✓" : "!";
  title.textContent = t(kind === "ok" ? "agent.operationDone" : "agent.operationFailed");
  detail.textContent = text;
  close.setAttribute("aria-label", t("bc.close"));
  toast.hidden = false;
  scheduleDismiss();
}
