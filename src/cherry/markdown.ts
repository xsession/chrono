function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inline(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

export function renderMarkdown(source: string): string {
  const lines = source.split(/\r?\n/);
  const output: string[] = [];
  let inList = false;

  for (const line of lines) {
    if (/^###\s+/.test(line)) {
      if (inList) { output.push("</ul>"); inList = false; }
      output.push(`<h3>${inline(line.replace(/^###\s+/, ""))}</h3>`);
    } else if (/^##\s+/.test(line)) {
      if (inList) { output.push("</ul>"); inList = false; }
      output.push(`<h2>${inline(line.replace(/^##\s+/, ""))}</h2>`);
    } else if (/^#\s+/.test(line)) {
      if (inList) { output.push("</ul>"); inList = false; }
      output.push(`<h1>${inline(line.replace(/^#\s+/, ""))}</h1>`);
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) { output.push("<ul>"); inList = true; }
      output.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
    } else if (line.trim()) {
      if (inList) { output.push("</ul>"); inList = false; }
      output.push(`<p>${inline(line)}</p>`);
    } else if (inList) {
      output.push("</ul>");
      inList = false;
    }
  }

  if (inList) output.push("</ul>");
  return output.join("");
}
