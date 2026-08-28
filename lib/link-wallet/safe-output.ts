/** Return an account hint that cannot disclose a complete Link identifier. */
export function maskLinkAccountLabel(input: unknown) {
  if (typeof input !== "string") return undefined;
  const value = input.trim();
  if (!value) return undefined;
  const at = value.lastIndexOf("@");
  if (at > 0 && at < value.length - 1) {
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    return clamp(`${visiblePrefix(local)}•••@${maskDomain(domain)}`);
  }

  const digits = value.replace(/\D/gu, "");
  if (
    digits.length >= 4 &&
    (digits.length >= value.length / 2 || /[•*]/u.test(value))
  ) {
    return `••• ••• ${digits.slice(-4)}`;
  }

  const first = Array.from(value)[0];
  return first ? `${first}•••` : undefined;
}

function visiblePrefix(value: string) {
  return Array.from(value)[0] ?? "";
}

function maskDomain(value: string) {
  const labels = value.split(".").filter(Boolean);
  if (labels.length === 0) return "•••";
  const suffix = labels.length > 1 ? `.${labels.at(-1) ?? ""}` : "";
  return `${visiblePrefix(labels[0] ?? "")}•••${suffix}`;
}

function clamp(value: string) {
  return Array.from(value).slice(0, 120).join("");
}
