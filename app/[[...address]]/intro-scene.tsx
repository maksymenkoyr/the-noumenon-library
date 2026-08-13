"use client";

import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from "react";
import { animate, clamp, Easing, interpolate, type SceneName } from "@/lib/composition";

/**
 * The intro piece: a single glyph in the dark locks, character by
 * character, into three predefined texts, while the camera pulls back
 * from that glyph to a page, a book, a plain of pages, then dives back in.
 *
 * Ported near-verbatim from `Library of Babel animation/babel-scene.jsx`
 * (a design-tool prototype, not shipped) — same tables, same math, same
 * render tree. What changed: `window`-global engine imports become module
 * imports from lib/composition; the prototype's tweaks panel is gone, so
 * its last-saved values (Library of Babel.dc.html TWEAK_DEFAULTS) are
 * fixed constants below instead of live props; and CompositionProvider/
 * useComposition/Shot — a few lines of the prototype's much larger
 * CompositionStage/Shot (animations-v3.jsx) — are reproduced locally since
 * this is now their only consumer.
 */

const INK = "#0a0c11";
const PAPER = "#efe9dc";
// All narration — the resolving hero line (Page, below), "somewhere in all
// that noise", and the five titles — sets this one face, so the titles read
// as made of the same material as the text that locks in out of the noise
// rather than as separate UI captions. Wired through intro.tsx
// (intro-fonts.ts's `.variable` applied to the stage wrapper).
const MONO = "var(--font-intro-mono), 'Noto Sans Mono', ui-monospace, monospace";

// Last-saved values from Library of Babel.dc.html's TWEAK_DEFAULTS — the
// prototype's tweaks panel is gone, so these are fixed instead of live.
const ACCENT = "#a9b6c8";
const LABELS = true;
const VERTIGO = 0.14;

/* ── minimal composition context: T (authored seconds) + cues, fed by the
   shell's clock (intro.tsx) ── */

interface CompositionValue {
  T: number;
  cues: Record<SceneName, number>;
}

const CompositionContext = createContext<CompositionValue | null>(null);

export function CompositionProvider({
  T,
  cues,
  children,
}: CompositionValue & { children: ReactNode }) {
  const value = useMemo(() => ({ T, cues }), [T, cues]);
  return <CompositionContext.Provider value={value}>{children}</CompositionContext.Provider>;
}

function useComposition(): CompositionValue {
  const ctx = useContext(CompositionContext);
  if (!ctx) throw new Error("useComposition() must be called inside <CompositionProvider>");
  return ctx;
}

/** Visible only while T is within [from, to); children stay mounted throughout. */
function Shot({ from, to = Infinity, children }: { from: number; to?: number; children: ReactNode }) {
  const { T } = useComposition();
  const on = isFinite(from) && T >= from && T < to;
  return (
    <div style={{ position: "absolute", inset: 0, visibility: on ? "visible" : "hidden" }}>
      {children}
    </div>
  );
}

/* high-temperature soup: latin, punctuation, and other scripts */
const LATIN = "abcdefghilmnopqrstuvxz,. ";
const OTHER =
  "абвгдежзийклмнопрстуфцчшщыэюя" +
  "αβγδεζηθικλμνξπρστυφχψω" +
  "אבגדהוזחטיכלמנסעפצקרשת" +
  "ابتثجحخدذرزسشصضطظعغفقك" +
  "अआइईउऊकखगघचछजझटठडढणतथदधनपफबभमयरलवशषसह" +
  "的一是不了人我在有他这为之大来以个中上们到说国和地也子时道出而要于就下得可你年生" +
  "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロ";
const NOISE = LATIN.repeat(3) + OTHER;

const COLS = 70,
  ROWS = 40,
  FS = 18.5,
  CHAR_W = 11.1,
  LINE_H = 22.5;
const PAGE_W = COLS * CHAR_W,
  PAGE_H = ROWS * LINE_H;
const LINE = 19;
/* the one column the camera opens on — a real letter in all three texts */
const HERO = 35;

function padded(str: string, pad: number): string {
  return " ".repeat(pad) + str + " ".repeat(COLS - pad - str.length);
}

interface TextSpec {
  t: string;
  start: number;
  len: number;
  from: number;
  to: number;
  out: number;
  outTo: number;
  heroAt?: number;
}

/* every text is predefined; characters lock into it one by one.
 *
 * Constraint on any edit here: HERO (35) is the one column the camera opens
 * on and holds through the whole piece, so `str[HERO - pad]` — i.e.
 * `t[HERO]`, since padded() left-pads by `pad` — must be a real,
 * non-space character in EVERY text below, or the opening shot locks onto
 * blank space. `pad` (the padded()/start argument) is chosen for this, not
 * for centering — it's nudged off dead-centre wherever the true middle
 * would land on a space. Keep `len` equal to the string's length; frac()
 * uses it to stagger each character's lock time across the line.
 */
const TEXTS: TextSpec[] = [
  {
    t: padded("any symbol, in any order", 23),
    start: 23,
    len: 24,
    from: 3.5,
    to: 9.0,
    out: 11.5,
    outTo: 12.6,
    heroAt: 2.1,
  },
  {
    t: padded("every page that could ever be written is already here", 8),
    start: 8,
    len: 53,
    from: 20.4,
    to: 24.0,
    out: 25.9,
    outTo: 26.5,
  },
  {
    t: padded("wander in. see what finds you.", 20),
    start: 20,
    len: 30,
    from: 26.2,
    to: 27.6,
    out: Infinity,
    outTo: Infinity,
  },
];

function prand(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}
function pick(n: number): string {
  return NOISE[Math.floor(prand(n) * NOISE.length) % NOISE.length];
}
const WIDE_RE = /[぀-ヿ㐀-鿿豈-﫿＀-￯가-힯]/;
function frac(tx: TextSpec, j: number): number {
  if (j === HERO) return 0;
  const f = (j - tx.start) / Math.max(1, tx.len - 1);
  return clamp(f * 0.8 + prand(j * 3.1) * 0.2, 0, 1);
}

function buildLines(tick: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < ROWS; i++) {
    let s = "";
    for (let j = 0; j < COLS; j++) s += pick(i * 97.13 + j * 3.71 + tick * 131.7);
    out.push(s);
  }
  return out;
}

/* --- three motion helpers, nothing eases outside them --- */
const MOTION = {
  glide: (kf: number[], vals: number[]) => interpolate(kf, vals, Easing.easeInOutSine),
  enter: (start: number, dur: number) =>
    animate({ from: 0, to: 1, start, end: start + dur, ease: Easing.easeOutCubic }),
  hold: (T: number, a: number, b: number, f?: number) =>
    clamp(Math.min((T - a) / (f || 0.45), (b - T) / (f || 0.45)), 0, 1),
};

/* --- the plain of pages --- */
const CELL_W = 940,
  CELL_H = 1090,
  RING = 5;
const CELLS: [number, number][] = (() => {
  const a: [number, number][] = [];
  for (let c = -RING; c <= RING; c++)
    for (let r = -RING; r <= RING; r++) {
      if (c === 0 && r === 0) continue;
      a.push([c, r]);
    }
  return a;
})();
const cellX = (c: number) => c * CELL_W;
const cellY = (r: number) => r * CELL_H;

interface NamedCell {
  c: number;
  r: number;
  title: string;
  at: number;
}

// Each title names something readable (a page, not a place or an object) —
// titles sit on pages, and the library never claims to know facts about the
// visitor, so nothing here promises to retrieve one. Keep every title ≲28
// chars: at this point z ≈ 0.14, and a title's x position
// (`clamp(540 + panX + cellX(c) * z, 170, 910)`) hits its clamp at the
// outermost cells (c: -3 and c: 3), pinning them hard against the stage
// edges — a longer line there overflows.
const NAMED: NamedCell[] = [
  { c: -2, r: -1, title: "the letter you never sent", at: 15.3 },
  { c: 2, r: -2, title: "the last dream before waking", at: 16.2 },
  { c: -3, r: 1, title: "how it ends", at: 17.1 },
  { c: 1, r: 2, title: "a memory that isn't yours", at: 18.0 },
  { c: 3, r: 0, title: "poems no one has written", at: 18.8 },
];
const TITLE_LIFE = 1.7;

function pageBox(c: number, r: number, extra: CSSProperties): CSSProperties {
  return {
    position: "absolute",
    left: "50%",
    top: "50%",
    width: PAGE_W,
    height: PAGE_H,
    marginLeft: -PAGE_W / 2 + cellX(c),
    marginTop: -PAGE_H / 2 + cellY(r),
    ...extra,
  };
}

function PageGrid({ op }: { op: number }) {
  const cells = useMemo(
    () =>
      CELLS.map(([c, r], i) => {
        const gap = 11 + Math.round(prand(i * 3.3) * 8);
        return (
          <div key={i} style={pageBox(c, r, { background: "rgba(239,233,220,0.038)" })}>
            <div
              style={{
                position: "absolute",
                left: "7%",
                right: "7%",
                top: "6%",
                bottom: "6%",
                opacity: 0.1 + prand(i * 7.1) * 0.14,
                background:
                  "repeating-linear-gradient(0deg, rgba(239,233,220,0.85) 0px, rgba(239,233,220,0.85) 2px, transparent 2px, transparent " +
                  gap +
                  "px)",
              }}
            />
          </div>
        );
      }),
    [],
  );
  return <div style={{ position: "absolute", inset: 0, opacity: op }}>{cells}</div>;
}

function Page({
  lines,
  T,
  fast,
  bgVis,
  glow,
  op,
  focus,
  textFade,
}: {
  lines: string[];
  T: number;
  fast: number;
  bgVis: number;
  glow: number;
  op: number;
  focus: number;
  textFade: number;
}) {
  const rows: ReactNode[] = [];
  for (let i = 0; i < ROWS; i++) {
    if (i === LINE) {
      const spans: ReactNode[] = [];
      for (let j = 0; j < COLS; j++) {
        let ch: string | null = null;
        for (let k = 0; k < TEXTS.length; k++) {
          const tx = TEXTS[k];
          if (j < tx.start || j >= tx.start + tx.len) continue; // padding stays churn, never locks
          const f = frac(tx, j);
          const lock = tx.heroAt != null && j === HERO ? tx.heroAt : tx.from + (tx.to - tx.from) * f;
          const unlock = tx.out === Infinity ? Infinity : tx.out + (tx.outTo - tx.out) * (1 - f);
          if (T >= lock && T < unlock) ch = tx.t[j];
        }
        const locked = ch !== null;
        if (!locked) ch = pick(i * 97.13 + j * 3.71 + fast * 131.7);
        const hero = j === HERO;
        spans.push(
          <span
            key={j}
            style={{
              display: "inline-block",
              width: CHAR_W,
              textAlign: "center",
              verticalAlign: "top",
              overflow: hero ? "visible" : "hidden",
              fontSize: (WIDE_RE.test(ch!) ? FS * 0.6 : FS) + "px",
              color: locked || hero ? PAPER : "rgba(239,233,220,0.4)",
              opacity: locked || hero ? textFade : 0.8 * bgVis,
              textShadow:
                (hero || locked) && glow > 0.01
                  ? "0 0 " + (16.8 * glow).toFixed(1) + "px rgba(239,233,220,0.75)"
                  : "none",
            }}
          >
            {ch === " " ? " " : ch}
          </span>,
        );
      }
      rows.push(
        <div key={i} style={{ height: LINE_H }}>
          {spans}
        </div>,
      );
    } else {
      rows.push(
        <div
          key={i}
          style={{
            height: LINE_H,
            color: "rgba(239,233,220,0.52)",
            opacity: (0.55 + prand(i * 7.7) * 0.4) * (1 - 0.62 * focus) * bgVis,
            whiteSpace: "pre",
          }}
        >
          {lines[i]}
        </div>,
      );
    }
  }
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: PAGE_W,
        height: PAGE_H,
        marginLeft: -PAGE_W / 2 + CHAR_W / 2 - (HERO - (COLS / 2 - 1)) * CHAR_W,
        marginTop: -PAGE_H / 2 + LINE_H / 2,
        font: "400 " + FS + "px/" + LINE_H + "px " + MONO,
        whiteSpace: "pre",
        overflow: "hidden",
        opacity: op,
      }}
    >
      {rows}
    </div>
  );
}

export function IntroScene() {
  const { T, cues: CUES } = useComposition();
  const accent = ACCENT;
  const labels = LABELS;
  const minZ = VERTIGO;

  const z = Math.exp(
    MOTION.glide(
      [0, 1.0, CUES.Alphabet, 6.6, 9.4, 10.8, CUES.Pages, 15.4, CUES.Everything, 22.6, CUES.Close, 27.0, 30],
      [34, 30, 20, 6.0, 2.2, 1.0, 1.0, minZ, minZ, 1.26, 1.26, 1.44, 1.92].map(Math.log),
    )(T),
  );

  const panX = 26 * Math.sin(T * 0.33);
  const panY = 18 * Math.sin(T * 0.24);

  const tick = Math.floor(T * 7);
  const lines = useMemo(() => buildLines(tick), [tick]);
  const fast = Math.floor(T * 14);

  const glow = MOTION.glide([0, 4, 9], [1, 0.85, 0.3])(T);
  const focus = Math.max(MOTION.hold(T, 6.6, TEXTS[0].outTo, 0.9), MOTION.hold(T, 22.4, 40, 0.9));
  const bgVis = 1 - MOTION.enter(CUES.Close + 1.3, 1.9)(T);
  const textFade = 1 - MOTION.enter(29.0, 1.0)(T);
  const pageOp = clamp((z - 0.05) / 0.28, 0.1, 1);
  const gridOp = MOTION.hold(T, CUES.Pages + 0.1, CUES.Everything + 1.6, 1.0);
  const stackOp = MOTION.hold(T, CUES.OneBook + 1.2, CUES.Pages + 0.6, 1.0) * 0.85;
  const titlesGone = 1 - MOTION.enter(CUES.Everything + 0.1, 0.5)(T);

  return (
    <div style={{ position: "absolute", inset: 0, background: INK, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: "translate(" + panX.toFixed(2) + "px," + panY.toFixed(2) + "px) scale(" + z.toFixed(5) + ")",
          transformOrigin: "50% 50%",
        }}
      >
        <Shot from={CUES.Pages - 1} to={CUES.Close + 1.8}>
          <PageGrid op={gridOp} />
          {NAMED.map((n, i) => {
            const p = MOTION.hold(T, n.at, n.at + TITLE_LIFE, 0.4) * gridOp * titlesGone;
            if (p < 0.01) return null;
            return (
              <div
                key={i}
                style={pageBox(n.c, n.r, {
                  border: (3 / z).toFixed(0) + "px solid " + accent,
                  background: "rgba(239,233,220,0.1)",
                  boxShadow: "0 0 " + (90 / z).toFixed(0) + "px " + accent + "33",
                  opacity: p,
                  transform: "scale(" + (1 + 0.3 * p).toFixed(3) + ")",
                })}
              />
            );
          })}
        </Shot>

        {[5, 4, 3, 2, 1].map((k) => (
          <div
            key={k}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: PAGE_W + 40,
              height: PAGE_H + 40,
              marginLeft: -(PAGE_W + 40) / 2 + k * 11,
              marginTop: -(PAGE_H + 40) / 2 - k * 11,
              border: "1px solid rgba(239,233,220,0.5)",
              opacity: stackOp / k,
            }}
          />
        ))}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: PAGE_W + 40,
            height: PAGE_H + 40,
            marginLeft: -(PAGE_W + 40) / 2,
            marginTop: -(PAGE_H + 40) / 2,
            border: "1px solid rgba(239,233,220,0.55)",
            opacity: stackOp * 1.4,
            background: "rgba(10,12,17,0.6)",
          }}
        />

        <Page lines={lines} T={T} fast={fast} bgVis={bgVis} glow={glow} op={pageOp} focus={focus} textFade={textFade} />
      </div>

      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background:
            "radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 26%, rgba(0,0,0,0.62) 82%, rgba(0,0,0,0.9) 100%)",
          opacity: 0.55 + 0.45 * (1 - MOTION.enter(1.0, 2.2)(T)),
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          opacity: 0.022,
          background:
            "repeating-linear-gradient(0deg, rgba(255,255,255,0.9) 0px, rgba(255,255,255,0.9) 1px, transparent 1px, transparent 5px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: "24%",
          pointerEvents: "none",
          background: "linear-gradient(to bottom, rgba(7,8,11,0.88), rgba(7,8,11,0))",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: "32%",
          pointerEvents: "none",
          background: "linear-gradient(to top, rgba(7,8,11,0.9), rgba(7,8,11,0))",
        }}
      />

      {labels && (
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: "11%",
              textAlign: "center",
              font: "400 44px " + MONO,
              color: PAPER,
              letterSpacing: "0.01em",
              opacity: MOTION.hold(T, CUES.Pages + 0.9, CUES.Everything - 0.4, 0.55),
            }}
          >
            somewhere in all that noise
          </div>

          {NAMED.map((n, i) => {
            const p = MOTION.hold(T, n.at + 0.15, n.at + TITLE_LIFE, 0.4) * titlesGone;
            if (p < 0.01) return null;
            const x = clamp(540 + panX + cellX(n.c) * z, 170, 910);
            const y = 540 + panY + (cellY(n.r) + PAGE_H * 0.62) * z;
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: x,
                  top: y,
                  transform: "translate(-50%,0)",
                  font: "400 33px " + MONO,
                  color: PAPER,
                  whiteSpace: "nowrap",
                  opacity: p,
                  textShadow: "0 2px 18px rgba(7,8,11,0.95)",
                }}
              >
                {n.title}
              </div>
            );
          })}
        </div>
      )}
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background: INK,
          opacity: MOTION.enter(29.0, 1.0)(T),
        }}
      />
    </div>
  );
}
