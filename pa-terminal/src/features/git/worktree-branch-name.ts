/** Generate once when opening the dialog; use the device's local clock. */
export function generateWorktreeBranchName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(3)),
    (value) => value.toString(16).padStart(2, "0")).join("");
  return `worktree/${date}-${time}-${suffix}`;
}
