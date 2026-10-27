export interface GuestCredentials { username: string; password: string; }
const STORAGE_KEY = "praglish.guest.credentials.v1";

export function guestCredentials(): GuestCredentials {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as GuestCredentials;
      if (typeof parsed.username === "string" && typeof parsed.password === "string") return parsed;
    } catch { /* Regenerate invalid local credentials. */ }
  }
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const credentials = { username: `guest_${id}`, password: crypto.randomUUID() };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
  return credentials;
}

export function guestAuthHeader(): string {
  const { username, password } = guestCredentials();
  return `Basic ${btoa(`${username}:${password}`)}`;
}
