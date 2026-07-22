# AlphaNet public Web visual design QA

## Comparison target

- Source visual truth: `/Users/zhiyuansong/Downloads/45d1ae48-4743-437d-908c-a96fd1d7624b.png`
- Browser-rendered implementation: `http://127.0.0.1:3101/`
- Final desktop screenshot: `/tmp/alphanet-ui-audit-20260721/63-home-buttons-final-build.png`
- Final mobile screenshot: `/tmp/alphanet-ui-audit-20260721/60-home-buttons-mobile-full.png`
- Community/search responsive evidence:
  - `/tmp/alphanet-ui-audit-20260721/65-search-professional-agent-final.png`
  - `/tmp/alphanet-ui-audit-20260721/66-communities-clean-glass-card.png`
  - `/tmp/alphanet-ui-audit-20260721/68-search-professional-agent-mobile.png`
  - `/tmp/alphanet-ui-audit-20260721/61-search-results-final-mobile.png`
- Full-view comparison: `/tmp/alphanet-ui-audit-20260721/62-source-home-final-comparison.png`
- State: public, unauthenticated landing page; public communities and real local search results; dark theme.

The source is the approved brand-art direction rather than a literal page mock. QA therefore requires exact hero-asset fidelity and faithful palette, glass-edge, character and density decisions, while the surrounding Web layout continues AlphaNet's existing enterprise social-product system.

## Normalization

- Source: `1536 × 1024` RGB PNG.
- Implementation capture: `1521 × 1014` JPEG from a `1536 × 1024` CSS Chrome viewport at density `1`; the capture excludes browser scrollbar/chrome pixels.
- The implementation was proportionally fitted and black-padded to `1536 × 1024`, then placed beside the source in one `3072 × 1024` comparison image.
- The production hero file is byte-identical to the approved source. Both SHA-256 checksums are `66e379d65a6a2142f79338b4910eb892e3f0c69d638c72070bc4fc9545531c41`.
- Mobile was checked at `390 × 844` and `320 × 800` CSS viewports. Full-page captures are narrower than the requested viewport by the browser scrollbar width; measured document width remained within the content viewport with no horizontal overflow.

## Findings

No actionable P0, P1 or P2 difference remains.

- **Fonts and typography:** the final display line is the single-line `Welcome to AlphaNet`; the Chinese eyebrow retains the exact product category `Agent 投资研究社交网络`. At desktop the title has equal client and scroll widths (`508px`) and keeps `55.6px` of visible clearance from the hero image. It remains one line at 390px and 320px without page overflow. Body copy uses the existing Inter/system CJK stack at product-reading sizes rather than imitating lettering baked into the illustration.
- **Spacing and layout rhythm:** the desktop hero is a balanced editorial split, while tablet and mobile stack into one column. The two CTAs now form one `430px` action group; each desktop button is `209 × 48px`, with equal width, radius and alignment. The four-step social loop and lower access panel stay on rule-line structure rather than becoming a card wall.
- **Colors and visual tokens:** black, warm white and acid green map directly to the source. Green-edge glass is limited to search/filter tools, one homepage auxiliary panel, and genuine system states. Research feeds, real search results, sources, replies and Markdown remain flat and divider-led.
- **Image quality and asset fidelity:** the supplied hero is rendered uncropped at its native `3:2` ratio directly on the black page, with no frame, fake glow or CSS recreation. State art remains in the approved character direction. Glass-card companion art is limited to the content-search workspace and uses one professional Agent reviewing a tablet, without the cat; black/screen blending was removed after transparency was verified.
- **Copy and content:** the landing page no longer repeats the product name as a second two-line Chinese headline. `开放注册` and `浏览开放社区` are concise, real actions. Search copy leads with posts, replies, opposing views, questions, sources and discussion relationships, preserving the social-network positioning.
- **Icons and decorative assets:** no emoji, handcrafted SVG, div art or placeholder illustration replaces source imagery. The card companion is decorative with empty alt text; meaningful state illustrations have accompanying text.
- **Responsiveness:** the earlier repeated card companion overlapped the paragraph above community/search tools on mobile. The community directory now keeps its compact glass search card clean; the one remaining content-search companion occupies reserved space and touches only the search-card edge at desktop and 390px. The 390px document width measured `375px`; the 320px document width measured `305px`, with no horizontal scroll.
- **States and interactions:** `开放注册` navigates to the real registration form; `浏览开放社区` opens the real community directory; the `AMD 看空观点与反驳` example performs a real request and returns one demo result with sources, replies and separate Helpful/Agree/Disagree signals. Search degradation is stated truthfully. Chrome showed no Next.js runtime-error overlay or visible error alert in the checked states.
- **Accessibility:** navigation retains semantic links and current-page state, forms retain labels, the approved hero has descriptive alt text, decorative companions use empty alt plus `aria-hidden`, controls meet the `44px` target, focus styling is preserved, and character drift is disabled under `prefers-reduced-motion`.

## Comparison history

1. The first pass used a repeated two-line product statement and made the page feel separated from the English-language visual. Capability chips also competed with the hero. The chips were removed and the headline was simplified.
2. A Chinese `欢迎来到 / AlphaNet` headline improved meaning but still created a heavy two-line break. It was replaced with the single-line `Welcome to AlphaNet`, while the eyebrow kept the Chinese positioning.
3. The first single-line desktop capture revealed title overflow into the grid gap. The display size and grid ratio were tightened until client width equaled scroll width and a measured image gap remained.
4. The first card-companion mobile capture revealed a P2 overlap with the preceding description. The repeated robot-and-cat decoration was removed from the homepage status panel and community directory; content search now uses one tightly cropped, professional single-Agent research action with reserved responsive clearance.
5. The initial CTA pair read as one short button plus a text link. Both actions were rebuilt as equal `48px`-high buttons and verified at desktop and mobile sizes.
6. The final combined comparison and focused desktop/mobile captures show the fixes in place with no remaining P0/P1/P2 item.

## Focused comparison evidence

The `3072 × 1024` combined image is sufficient for overall palette, composition, hierarchy and hero treatment. Typography and controls were additionally inspected at original detail in the standalone desktop and mobile captures. A separate hero crop is unnecessary because the production hero and source are byte-identical; responsive DOM measurements independently verify title, CTA, image-gap and mascot-clearance geometry.

## Implementation checklist

- [x] Use the exact approved hero without a Web frame or artificial glow.
- [x] Use `Welcome to AlphaNet` as one responsive line.
- [x] Restore `开放注册` and give both hero actions equal visual weight and usable dimensions.
- [x] Reserve one real transparent, professional single-Agent companion for the content-search glass card only.
- [x] Keep real research, Markdown, sources and replies on the rule-line content system.
- [x] Verify desktop, 390px and 320px layouts in Chrome.
- [x] Exercise registration, community discovery and real search-result paths.

## Follow-up polish

- P3: after the production font-loading policy is final, compare Windows CJK fallback weight and line breaking against the macOS captures.

final result: passed
