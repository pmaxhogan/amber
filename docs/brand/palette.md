# Amber color system

The definitive palette for Amber. Dark-first: every value below is chosen so the
dark UI is the good one and the light UI is a correct, unembarrassing fallback.

Two rules drive everything else:

1. Amber is a light hue. Amber 500 is too bright to carry white text and too dark
   to sit on a dark surface as a fill without dark text on top. Its "on" color is
   always a near-black warm brown, never white.
2. Dark mode reaches for 400/500; light mode reaches for 600/700. Do not use one
   scale position in both schemes and expect the contrast to hold.

---

## Amber primary scale

| Token | Hex | Notes |
| --- | --- | --- |
| primary-50 | `#fef7ec` | light-mode tinted background, selected row wash |
| primary-100 | `#fcebce` | light-mode hover wash, badge background |
| primary-200 | `#f9d79c` | light-mode borders on tinted surfaces |
| primary-300 | `#f5bc63` | dark-mode hover/active brightening, decorative strokes |
| primary-400 | `#f0a138` | dark-mode text and icon accent, dark-mode hover fill |
| primary-500 | `#e8890f` | the brand color; dark-mode primary fill |
| primary-600 | `#c4690b` | dark-mode active/pressed fill; light-mode fill for large text only |
| primary-700 | `#9e4f0d` | light-mode primary fill, text, and icon accent |
| primary-800 | `#7f3f12` | light-mode hover fill; dark-mode tinted surfaces, deep borders |
| primary-900 | `#6a3512` | light-mode active fill; dark-mode badge/callout background |
| primary-950 | `#3d1b07` | dark-mode subtle amber wash, near-surface tint |

Supporting values used by the logo art (not general UI tokens):

- inclusion brown `#5e2c0c` - the commit graph inside the drop
- rim `#8f4408` - silhouette definition so the mark survives a white background
- drop gradient stops: `#ffd98a` -> `#f2a63c` -> `#e8890f` -> `#a9520a`

### Contrast, measured

Against the dark page background `#14100d`:

| Color | Ratio | Verdict |
| --- | --- | --- |
| primary-300 `#f5bc63` | 11.0:1 | AAA, body text safe |
| primary-400 `#f0a138` | 8.9:1 | AAA, body text safe |
| primary-500 `#e8890f` | 7.2:1 | AAA large, AA normal |
| primary-600 `#c4690b` | 4.8:1 | AA normal |

Against white `#ffffff`:

| Color | Ratio | Verdict |
| --- | --- | --- |
| primary-600 `#c4690b` | 3.9:1 | AA large / UI components only |
| primary-700 `#9e4f0d` | 5.9:1 | AA normal |

On top of primary-500 as a fill:

| Text color | Ratio | Verdict |
| --- | --- | --- |
| `#ffffff` | 2.6:1 | fails, do not use |
| `#2a1a0b` | 6.4:1 | correct "on-primary" |

This is the single most important number in the file. A filled amber button gets
dark text. In PrimeVue terms, `primary.contrastColor` is `#2a1a0b` in both color
schemes, never `#ffffff`.

---

## Warm dark surface scale

A warm stone neutral. It carries a trace of the brand hue so amber sits on it
without looking pasted on, but stays desaturated enough to read as a real gray.

| Token | Hex | Role |
| --- | --- | --- |
| surface-0 | `#ffffff` | light-mode card, dark-mode nothing |
| surface-50 | `#faf7f4` | light-mode page background |
| surface-100 | `#f3eee8` | light-mode subtle fill, hover |
| surface-200 | `#e7dfd5` | light-mode border |
| surface-300 | `#d5c9bb` | light-mode strong border, disabled edge |
| surface-400 | `#ac9e8d` | light-mode placeholder, disabled text |
| surface-500 | `#857868` | mid neutral, icon default on light |
| surface-600 | `#6a5d50` | light-mode muted text |
| surface-700 | `#4e443a` | dark-mode strong border, light-mode body text |
| surface-800 | `#332c25` | dark-mode border, elevated hover |
| surface-900 | `#1e1815` | dark-mode card background |
| surface-950 | `#14100d` | dark-mode page background |

### Named dark-surface roles

| Role | Hex | Notes |
| --- | --- | --- |
| page background | `#14100d` | surface-950, the app shell |
| card / panel | `#1e1815` | surface-900, one step up |
| elevated (menu, dialog, popover) | `#2a231d` | between 900 and 800 |
| border subtle | `#2a231d` | dividers inside a card |
| border | `#3a3129` | card edges, input outlines |
| border strong | `#4e443a` | surface-700, focused input, active edge |

Layering rule: page `#14100d` -> card `#1e1815` -> elevated `#2a231d`. Each step
is a lift in lightness, not a drop shadow. Reserve shadow for genuinely floating
surfaces (dialog, dropdown), and keep it warm-black at low alpha, for example
`rgba(10, 7, 4, 0.55)`.

---

## Text colors

Dark mode, measured against `#14100d`:

| Role | Hex | Ratio |
| --- | --- | --- |
| text primary | `#f5efe7` | 16.6:1 |
| text muted | `#b8aa9a` | 8.3:1 |
| text subtle | `#8a7d6e` | 4.7:1 |
| text disabled | `#6a5d50` | 3.0:1 (decorative only, never load-bearing) |

Light mode, measured against `#faf7f4`:

| Role | Hex | Ratio |
| --- | --- | --- |
| text primary | `#1e1815` | 16.4:1 |
| text muted | `#4e443a` | 8.9:1 |
| text subtle | `#6a5d50` | 6.0:1 |
| text disabled | `#ac9e8d` | 2.5:1 (decorative only) |

Text subtle is the floor for anything a user has to read. Anything below it is
ornament and must not be the only way information is conveyed.

---

## Semantic colors

Tuned warm and slightly desaturated so they sit beside amber without the palette
turning into a traffic light. Dark values are measured against `#14100d`.

| Semantic | Dark | Ratio | Light | Ratio on `#faf7f4` |
| --- | --- | --- | --- | --- |
| success | `#57b87a` | 7.7:1 | `#1e7a47` | 5.0:1 |
| warn | `#f2ce4b` | 12.4:1 | `#8f6304` | 5.0:1 |
| error | `#e5605c` | 5.6:1 | `#c0322f` | 5.3:1 |
| info | `#6aa9e0` | 7.5:1 | `#1f6fb2` | 4.9:1 |

Tinted backgrounds for callouts and toasts on dark, all of which keep the
matching foreground above 4.5:1:

| Semantic | Dark background | Dark border |
| --- | --- | --- |
| success | `#152a1d` | `#255c3a` |
| warn | `#2b2410` | `#6b5a16` |
| error | `#2e1615` | `#6e2e2c` |
| info | `#141f2c` | `#2c4e6e` |

**Warn is close to the brand color, on purpose and at a cost.** On dark,
`#f2ce4b` is yellower and lighter than amber 500, which separates it well enough
at a glance. On light it is worse: `#8f6304` sits within 11 percent of amber 700
in luminance, so the two are told apart by hue alone. A warn state must therefore
never be signalled by color alone - always pair it with an icon and a text label.
The same discipline is good practice for every semantic here; for warn it is
mandatory.

An earlier draft used `#9a6b05` for warn on light. It measures 4.39:1, which
fails AA for normal text. Do not reintroduce it.

---

## Usage guide

**primary-500 vs primary-600.** 500 is the brand. Use it for the resting state of
a filled primary control in dark mode, for the logo, and for anything that means
"this is Amber." 600 is the working color: the dark-mode pressed/active state,
where you need a step down from 500 without changing hue. In light mode neither
one is the default fill - 500 and 600 both carry white text below 4.5:1, so the
light-mode fill is 700. Reach for 600 on light only when the control's text is
large (18.66px bold or 24px regular and up), where 3:1 is the bar.

**Interaction ladder.**

- Dark mode filled button: rest `#e8890f`, hover `#f0a138`, active `#c4690b`,
  text `#2a1a0b` throughout.
- Light mode filled button: rest `#9e4f0d`, hover `#7f3f12`, active `#6a3512`,
  text `#ffffff` throughout (5.9:1, 8.0:1, 9.9:1 - AA normal at every step).
- Text/link accent: `#f0a138` on dark, `#9e4f0d` on light.

These two ladders are what `amber-preset.ts` ships as `primary.color` /
`hoverColor` / `activeColor` per scheme. Change one and change the other.

**Focus ring.** 2px solid, offset 2px, color `{primary.color}` - which resolves
to amber-500 `#e8890f` on dark and amber-700 `#9e4f0d` on light.

The ring tracks the primary color rather than pinning its own hex, because Aura
declares `focusRing` at the `semantic` level, outside `colorScheme`. PrimeVue
requires an override to keep the original preset's structure, so there is no
supported way to give the ring one color in dark mode and another in light. A
single pinned value would have to satisfy both, and amber-400 - the value that
looks best on dark - is only 2.1:1 on white, below the 3:1 WCAG 2.1 non-text
floor. Following `{primary.color}` is what makes the ring legal in both schemes.

Measured, worst case first:

| Scheme | Ring | Worst background | Ratio |
| --- | --- | --- | --- |
| dark | `#e8890f` | surface-700 `#4e443a` | 3.6:1 |
| dark | `#e8890f` | page `#14100d` | 7.2:1 |
| light | `#9e4f0d` | surface-300 `#d5c9bb` | 3.6:1 |
| light | `#9e4f0d` | page `#faf7f4` | 5.5:1 |

Never remove the ring; if it collides with a control edge, increase the offset.

**Amber on amber.** Do not put amber text on an amber-tinted surface below
primary-900. The usable combination is primary-300 or primary-400 text on
primary-950 `#3d1b07` (9.0:1 and 7.3:1 respectively). Anything lighter as a
background needs the dark `#2a1a0b` foreground instead.

**Charts and the commit graph.** The DAG rendering is the one place amber and the
semantics share a canvas. Draw graph edges in surface-700 `#4e443a` on dark, and
reserve amber for the branch or commit under the cursor. Semantic colors on the
graph mean status (a failed backup is error, a verified snapshot is success), so
they must not be used decoratively to distinguish branches.

**Light mode is a fallback, not a mirror.** The light scheme exists so the GitHub
README, a printed doc, and a user who forces light mode all look intentional. Do
not spend design effort making the two schemes pixel-equivalent; spend it making
the dark one excellent and the light one correct.
