# Design tokens

The interface adapts the shared design archive's warm-paper, black-ink and highlighter-yellow system to the existing in-house intake flow. The original functional fields and review controls are retained.

| Token | Value | Use |
| --- | --- | --- |
| Paper | `#FAFAF8` | Page background |
| Ink | `#0A0A0A` | Text, rules and primary controls |
| Surface | `#FFFFFF` | Form and review cards |
| Muted | `#6B6B6B` | Labels and secondary copy |
| Divider | `#E8E8E5` | Hairline borders |
| Mark | `#FFD400` | Highlight and focus offset |
| Body | Libre Franklin, system sans fallback | Headings and form copy |
| Label | Roboto Mono, monospace fallback | Brand and uppercase actions |
| Shape | `0px` radius | Square controls and cards |
| Layout | 760px hero, 672px form; responsive gutters | Readable single-column workflow |

Font CSS is loaded from Google Fonts with local system fallbacks. See `frontend/design.css` for implementation and media queries.
