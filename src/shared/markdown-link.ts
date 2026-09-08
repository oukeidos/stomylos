// Shared by Markdown rendering and the privileged external-browser boundary.
export function markdownWebUrl(value: string): string {
  if (!/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f]/u.test(value)) return '';
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
