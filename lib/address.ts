/**
 * The address system — the library's permanent coordinates.
 *
 * `/{gallery}/{wall}/{shelf}/{volume}/{page}`, e.g. `/io-9/3/2/17/308`.
 * The four small dimensions come from Borges; the gallery token supplies
 * the vast-but-enumerable horizon (docs/architecture.md §5).
 *
 * normalizeAddress is EFFECTIVELY PERMANENT once pages are stored —
 * changing it orphans every page. It is locked by lib/address.test.ts.
 */

export const GALLERY_MAX_LENGTH = 12;
export const WALLS = 4;
export const SHELVES = 5;
export const VOLUMES = 32;
export const PAGES = 410;

// Gallery alphabets, ASCII-ordered so lexicographic order within a length
// equals enumeration order. Hyphen is interior-only (never first or last).
const EDGE_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const INNER_ALPHABET = "-" + EDGE_ALPHABET;

export interface Address {
  gallery: string;
  wall: number;
  shelf: number;
  volume: number;
  page: number;
}

const GALLERY_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
// Canonical decimal only: leading zeros, signs, etc. are distinct URLs and
// must 404 rather than silently alias onto a canonical page.
const NUMERIC_PATTERN = /^[1-9][0-9]{0,2}$/;

function parseDimension(segment: string, max: number): number | null {
  if (!NUMERIC_PATTERN.test(segment)) return null;
  const value = Number(segment);
  return value <= max ? value : null;
}

/**
 * Normalize raw URL segments into a canonical Address, or null if the
 * address is invalid. Pure. Lower-casing the gallery token is the only
 * transformation; everything else is reject-don't-clamp.
 */
export function normalizeAddress(
  segments: readonly string[],
): Address | null {
  if (segments.length !== 5) return null;

  const gallery = segments[0].toLowerCase();
  if (gallery.length > GALLERY_MAX_LENGTH || !GALLERY_PATTERN.test(gallery)) {
    return null;
  }

  const wall = parseDimension(segments[1], WALLS);
  const shelf = parseDimension(segments[2], SHELVES);
  const volume = parseDimension(segments[3], VOLUMES);
  const page = parseDimension(segments[4], PAGES);
  if (wall === null || shelf === null || volume === null || page === null) {
    return null;
  }

  return { gallery, wall, shelf, volume, page };
}

/**
 * Canonical string form — the future store primary key and prompt anchor.
 */
export function formatAddress(addr: Address): string {
  return `${addr.gallery}/${addr.wall}/${addr.shelf}/${addr.volume}/${addr.page}`;
}

/** URL path for an address, for hrefs and redirects. */
export function addressPath(addr: Address): string {
  return `/${formatAddress(addr)}`;
}

function alphabetAt(index: number, length: number): string {
  return index === 0 || index === length - 1 ? EDGE_ALPHABET : INNER_ALPHABET;
}

function smallestGallery(length: number): string {
  return length === 1 ? "0" : `0${"-".repeat(length - 2)}0`;
}

/**
 * Successor of a gallery token: a mixed-radix counter where edge positions
 * draw from EDGE_ALPHABET and interior positions from INNER_ALPHABET.
 * Carry past the leftmost character grows the token by one; past the
 * largest token the library wraps to gallery "0" — finite and closed.
 */
function nextGallery(gallery: string): string {
  const chars = gallery.split("");
  for (let i = chars.length - 1; i >= 0; i--) {
    const alphabet = alphabetAt(i, chars.length);
    const index = alphabet.indexOf(chars[i]);
    if (index < alphabet.length - 1) {
      chars[i] = alphabet[index + 1];
      return chars.join("");
    }
    chars[i] = alphabet[0];
  }
  const grown = gallery.length + 1;
  return grown > GALLERY_MAX_LENGTH ? smallestGallery(1) : smallestGallery(grown);
}

/**
 * The next page in reading order: page → volume → shelf → wall → gallery
 * rollover. Total: every address has a well-defined successor, and the
 * last page of the last gallery wraps to the first page of the library.
 */
export function nextAddress(addr: Address): Address {
  if (addr.page < PAGES) return { ...addr, page: addr.page + 1 };
  if (addr.volume < VOLUMES) {
    return { ...addr, page: 1, volume: addr.volume + 1 };
  }
  if (addr.shelf < SHELVES) {
    return { ...addr, page: 1, volume: 1, shelf: addr.shelf + 1 };
  }
  if (addr.wall < WALLS) {
    return { ...addr, page: 1, volume: 1, shelf: 1, wall: addr.wall + 1 };
  }
  return {
    gallery: nextGallery(addr.gallery),
    wall: 1,
    shelf: 1,
    volume: 1,
    page: 1,
  };
}

/**
 * The volume prefix "gallery/wall/shelf/volume" — the `books` table key
 * under the books experiment (docs/books.md), where volume = book.
 */
export function volumeKey(addr: Address): string {
  return `${addr.gallery}/${addr.wall}/${addr.shelf}/${addr.volume}`;
}

/**
 * Previous page within the same volume, or null on page 1. Unlike
 * nextAddress, never crosses the volume boundary — books are independent.
 */
export function prevPageInVolume(addr: Address): Address | null {
  return addr.page > 1 ? { ...addr, page: addr.page - 1 } : null;
}

/** Next page within the same volume, or null on page 410. */
export function nextPageInVolume(addr: Address): Address | null {
  return addr.page < PAGES ? { ...addr, page: addr.page + 1 } : null;
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randomChar(alphabet: string): string {
  return alphabet[Math.floor(Math.random() * alphabet.length)];
}

/**
 * A random valid address. Gallery length is chosen uniformly first so
 * random landings stay typeable — a deliberate deviation from strict
 * uniformity, under which near-max-length galleries would dominate.
 */
export function randomAddress(): Address {
  const length = randomInt(1, GALLERY_MAX_LENGTH);
  let gallery = "";
  for (let i = 0; i < length; i++) {
    gallery += randomChar(alphabetAt(i, length));
  }
  return {
    gallery,
    wall: randomInt(1, WALLS),
    shelf: randomInt(1, SHELVES),
    volume: randomInt(1, VOLUMES),
    page: randomInt(1, PAGES),
  };
}
