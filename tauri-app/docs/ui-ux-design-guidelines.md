# FPSMaster Launcher UI/UX Design Guidelines

## 1. Document Purpose

This document defines the visual system, interaction rules, information architecture, and component standards for `Launcher/tauri-app`.

It serves four goals:

1. Keep the launcher visually consistent as features grow.
2. Ensure UI decisions follow user mental models instead of feature-centric layouts.
3. Reduce one-off styling and ad-hoc component behavior.
4. Provide a shared contract for product, frontend, and backend collaboration.

This guideline is based on the current launcher implementation, especially:

- `src/styles.css`
- `src/components/Button.tsx`
- `src/components/Card.tsx`
- `src/components/Sidebar.tsx`
- `src/components/TitleBar.tsx`
- `src/components/Select.tsx`
- `src/pages/Home.tsx`
- `src/pages/Instances.tsx`
- `src/pages/Install.tsx`
- `src/pages/Content.tsx`
- `src/pages/AccountCenter.tsx`
- `src/pages/Settings.tsx`
- `src/pages/MandatoryUpdate.tsx`
- `src/pages/Monitor.tsx`

---

## 2. Product Positioning

FPSMaster Launcher is not a generic web dashboard and not a pure Minecraft skin shell.

It should feel like:

- a desktop control center for launching and maintaining game environments
- a trusted system surface for updates, installation, and account state
- a gaming product with technical polish, not a noisy “gaming RGB panel”

The intended experience is:

1. Fast to scan
2. Clear in hierarchy
3. Stable under repeated daily use
4. Capable of carrying system state, download state, update state, and account state without visual fatigue

The correct tone is:

- modern
- technical
- game-adjacent
- premium but restrained

The wrong tone is:

- over-glowing cyberpunk overload
- childish Minecraft parody
- overly enterprise SaaS admin
- marketing-page-first instead of workflow-first

---

## 3. Core UX Principles

### 3.1 One primary action per screen

Each page must have one obvious next action.

Examples:

- Home: launch selected instance
- Instances: manage or launch an instance
- Install: install a version
- Content: search/install/update content
- Settings: review and change runtime / visual preferences
- Mandatory Update: update launcher immediately

Secondary actions must remain visually subordinate.

### 3.2 System state must always be legible

The launcher is a state-heavy desktop product. Users must always be able to answer:

- Am I logged in?
- Which instance is active?
- Can I launch right now?
- Is an update required?
- Is my content installing, syncing, or blocked?

State must never be hidden inside decoration.

### 3.3 Prefer progressive disclosure over crowded panels

The launcher should show:

- current status
- next action
- one layer of supporting detail

Advanced detail should expand, modal, or move into a dedicated page, rather than overloading default layouts.

### 3.4 Feedback must be immediate and local

Every action with side effects must produce visible feedback near the trigger:

- button loading state
- inline progress
- inline error
- section-level status summary
- modal confirmation for destructive actions

### 3.5 The interface must reward routine use

This is a repeat-use launcher, not a one-time onboarding funnel.

Therefore:

- navigation should be stable
- repeated actions should become muscle memory
- dense information is acceptable if hierarchy remains clear
- decorative motion must never delay task completion

---

## 4. User Mental Model

The launcher should follow this mental sequence:

1. `What can I play right now?`
2. `What is the current state of my launcher and account?`
3. `How do I install, update, or fix something?`
4. `How do I manage content for a specific instance?`

This produces the following page roles:

### Home

Purpose:

- status overview
- latest launcher signals
- quick launch

Home should answer:

- what changed
- what is selected
- whether I can launch now

### Instances

Purpose:

- library of playable environments
- launch and manage installed instances

Instances should answer:

- what I already have
- which instances are blocked, ready, missing, or outdated

### Install

Purpose:

- create a new runtime environment with confidence

Install should answer:

- which Minecraft version
- which loader
- what will be installed

### Content

Purpose:

- acquire and maintain mods, resource packs, shaders, worlds

Content should answer:

- which instance I am modifying
- what source I am searching
- whether this item is installed or updatable

### Account Center

Purpose:

- identity, membership, activity, progression

### Settings

Purpose:

- runtime preferences
- theme and appearance
- launcher update management

### Mandatory Update

Purpose:

- block all non-compliant flows
- explain why
- direct the user toward a single safe action

### Monitor

Purpose:

- runtime observability
- process control
- log viewing

---

## 5. Visual Direction

### 5.1 Style Statement

The approved visual direction is:

**Technical game launcher with restrained glass surfaces and Minecraft-semantic accenting.**

This means:

- deep dark backgrounds by default
- layered translucent panels
- subtle accent glow, not high-saturation bloom everywhere
- geometry with medium radius, not sharp brutalist blocks and not overly rounded mobile cards
- Minecraft references should be semantic, not literal pixel cosplay

### 5.2 Brand Character

The launcher should visually communicate:

- precision
- trust
- responsiveness
- controlled energy

The current implementation already has the right foundation:

- dark structured shell
- accent-driven gradients
- glass/frost cards
- technical typography pairing

This document standardizes that foundation and narrows variation.

---

## 6. Color System

The launcher already exposes a good token structure in `src/styles.css`. Future work must use semantic tokens first, not hard-coded colors.

## 6.1 Primary Palette

### Base Dark Theme

| Token | Value | Usage |
|---|---:|---|
| `--bg` / `--bg-primary` | `#0b0d12` / `#0a0f13` | app background |
| `--bg-secondary` | `#0f171c` | secondary surfaces, panels |
| `--bg-tertiary` | `#172128` | controls, raised local surfaces |
| `--bg-elevated` | `#1f2b33` | elevated cards and pills |
| `--text` / `--text-primary` | `#f2f4f8` | primary text |
| `--text-secondary` | `#b8c9d3` | secondary content |
| `--text-muted` | `#81949f` | tertiary labels / metadata |
| `--border-subtle` | `rgba(255,255,255,0.08)` | low emphasis borders |
| `--border-medium` | `rgba(255,255,255,0.14)` | control borders |
| `--border-strong` | `rgba(255,255,255,0.22)` | emphasis borders |

### Default Accent Family

| Token | Value | Usage |
|---|---:|---|
| `--accent` / `--mc-grass` | `#25b87a` | primary brand action |
| `--mc-grass-dark` | `#1f985f` | hover / pressed action |
| `--mc-diamond` | `#57c89a` | positive highlights |
| `--mc-emerald` | `#30b985` | active highlights |
| `--mc-gold` | `#7dddb7` | soft accent fills |

### Status Colors

| Semantic | Token | Value | Rule |
|---|---|---:|---|
| Success / ready | `--success` | `#35d497` | use for completion only |
| Danger / destructive | `--danger`, `--accent-danger` | `#ff6b8f` | use for errors and destructive actions |
| Warning | amber family | existing inline amber usage | use for pending, required attention, mandatory update |

## 6.2 Accent Policy

Accent color is customizable, but semantic meaning must remain stable.

Rules:

1. Primary action surfaces use `--accent` family.
2. Success states should not become ambiguous when accent changes.
3. Danger must stay pink-red and must not depend on user accent.
4. Warning remains amber and must not be recolored by theme accent.
5. Informational neutrals stay in surface/text token families.

Supported accent presets currently include:

- emerald
- cyan
- violet
- sunset
- rose
- amber
- sky
- lime
- custom

These presets are acceptable, but all new component styles must derive from semantic tokens:

- `--accent`
- `--accent-soft`
- `--accent-strong`
- `--accent-rgb`

Never bind business state directly to a theme accent where it changes meaning.

## 6.3 Light Theme Policy

Light theme exists and should remain fully supported, but dark theme is the primary design reference.

Rules:

1. Light theme must preserve information hierarchy, not merely invert colors.
2. Border visibility must remain stronger than in dark mode.
3. Accent glow and blur must be reduced slightly in light mode.
4. Contrast on body text must remain comfortably readable for long sessions.

## 6.4 Hard-coded Color Rules

Hard-coded hex values in component/page code should be treated as exceptions.

Allowed only for:

- curated accent swatches in settings
- temporary migration areas
- external brand icons or source branding

Avoid spreading raw values like:

- `#25b87a`
- `#ff6b8f`
- `#25b87a]/10`

inside page markup when a token-backed utility or semantic class can be used.

---

## 7. Typography

The active type system is correct and should be retained:

- UI font: `Manrope`
- Mono/supporting font: `JetBrains Mono`

### 7.1 Type Roles

| Role | Use |
|---|---|
| Hero / page title | page H1 |
| Section title | card header / sub-page section |
| Body | standard labels, descriptions |
| Caption / meta | dates, counts, tags |
| Mono | versions, paths, hashes, process data, technical state |

### 7.2 Typography Rules

1. Page titles should be compact, high confidence, and non-decorative.
2. All uppercase should be restricted to micro labels, section eyebrows, and metadata tags.
3. Monospace is for technical facts only, not long descriptions.
4. Text hierarchy should rely first on size/weight/spacing, not color alone.

### 7.3 Recommended Scale

| Level | Suggested style |
|---|---|
| Page H1 | `text-3xl`, semibold, tight tracking |
| Section H2 | `text-lg` to `text-xl`, semibold |
| Card title | `text-base` or `text-sm`, semibold |
| Body | `text-sm` |
| Support text | `text-xs` to `text-[13px]` |
| Meta eyebrow | `text-[10px]` to `text-xs`, uppercase, tracking expanded |

---

## 8. Shape, Spacing, Elevation

### 8.1 Border Radius

Use the existing radius system:

- `--radius-md: 12px`
- `--radius-lg: 14px`
- `--radius-xl: 18px`

Recommended mapping:

| Component | Radius |
|---|---|
| Buttons / inputs / pills | 10-14px |
| Standard cards | 16-18px |
| Full-page emphasis card | 20-24px |
| Avatar circle / status dot | circular |

Do not mix sharp 4px corners with soft 18px cards in the same screen region.

### 8.2 Spacing

Page rhythm should follow a desktop spacing model:

- page outer padding: `16 / 20 / 24`
- card inner padding: `16 / 20 / 24`
- between sections: `20-32`
- between label and field: `8`
- between title and supporting copy: `4-8`

Avoid dense stacked micro-gaps that create visual jitter.

### 8.3 Elevation

The launcher uses three surface levels:

1. Shell background
2. Functional surface
3. Elevated emphasis card

Use elevation to communicate importance, not decoration.

Recommended mapping:

- Shell: page background, structural wrappers
- Surface: inputs, list rows, basic cards
- Elevated: hero cards, warnings, critical status blocks, modals

---

## 9. Motion and Interaction

### 9.1 Motion Philosophy

Motion should reinforce:

- focus
- state transition
- depth
- launch / install progress

Motion must not:

- feel ornamental
- delay primary action
- create visual noise during routine use

### 9.2 Timing

Use the existing timing tokens:

- `--duration-fast: 140ms`
- `--duration-normal: 220ms`
- `--duration-slow: 320ms`

Recommended usage:

- hover/focus: 140ms
- card transitions: 220ms
- modal enter/exit: 220-320ms
- background ambient shift: slow and subtle only

### 9.3 Motion Rules

1. Hover lift should stay under `translateY(-1px)`.
2. Glow should be soft and peripheral.
3. Progress animation must communicate real state, not infinite fake activity unless backend state is actually unknown.
4. Respect `prefers-reduced-motion` for non-essential animations.

---

## 10. Shell Layout Standards

## 10.1 Title Bar

The title bar is a desktop system surface, not a decorative header.

It must:

- remain compact
- expose clear window actions
- support drag region reliably
- communicate current context with `title + subtitle`

Rules:

1. Do not overload the title bar with page-level actions.
2. Title is contextual system state, not page marketing copy.
3. Danger styling is reserved for close.
4. Double-click maximize behavior should remain consistent.

## 10.2 Sidebar

The sidebar is the launcher’s stable navigation spine.

Rules:

1. Keep nav destinations stable and low in count.
2. Active state must be visible at a glance via border, glow, and icon emphasis.
3. User profile block belongs at the bottom and acts as account entry.
4. Collapse must preserve icon recognizability.
5. Sidebar labels should remain short and actionless; avoid sentence-like navigation labels.

## 10.3 Content Workspace

Main content areas should:

- scroll independently from shell
- keep visible top-level page identity
- support wide desktop layouts first
- degrade gracefully under compact width

---

## 11. Component Standards

## 11.1 Button

Current button variants are directionally correct, but usage rules must be explicit.

### Variants

| Variant | Meaning | Use |
|---|---|---|
| `primary` | primary task | main CTA on page or card |
| `secondary` | supporting action | less important but still available |
| `outline` | neutral alternative | non-destructive secondary tasks |
| `ghost` | low-emphasis inline action | utility, tertiary action |
| `danger` | destructive action | delete, stop, force-close |

`minecraft-success` and `minecraft-primary` should be treated as legacy aliases unless they are intentionally differentiated later.

### Rules

1. One primary button per local action group.
2. Danger actions must never visually compete with launch/install as the main CTA.
3. Loading and progress states must remain inside the button when directly tied to that action.
4. Disabled state must preserve legibility and reason context nearby.

## 11.2 Card

Cards are the primary information container.

Variants:

- `soft`
- `strong`
- `frost`

Usage:

| Variant | Use |
|---|---|
| `soft` | lightweight grouped information |
| `strong` | important grouped blocks |
| `frost` | premium/high-focus feature areas |

Rules:

1. Use cards to separate tasks, not to wrap every individual sentence.
2. Interactive halo should be reserved for actually interactive cards.
3. Cards that are only informative should use `interactive={false}`.
4. List rows inside cards should still maintain their own local hover/focus affordance.

## 11.3 Inputs and Select

Inputs must feel technical, not form-heavy.

Rules:

1. Labels always sit above the field.
2. Input height should remain consistent across text fields and select triggers.
3. Focus state uses accent border, not extra heavy glow.
4. Placeholder text should be descriptive and concise.
5. Dropdown menus must align with trigger width and keep item density readable.

## 11.4 Search

Search appears in `Home`, `Instances`, and `Content`.

Rules:

1. Search bars must include strong placeholder guidance.
2. Search should always be scoped by visible context.
3. Empty search is allowed when “trending” or default listing exists.
4. Results should visually reflect installed/available/blocked/update states.

## 11.5 Status Pills and Badges

Badges are useful in the current UI, but should be standardized.

Recommended semantic families:

| Type | Use |
|---|---|
| Neutral | metadata, mode, type |
| Accent | active selection, launch-ready |
| Warning | update available, pending review |
| Danger | blocked, failure, destructive |
| Success | installed, synced, complete |

Rules:

1. Badges must be short.
2. Badges communicate state, not explanation.
3. Explanations belong in adjacent support text.

## 11.6 Modal / Dialog

Use modal only when:

- user must make a decision before continuing
- action is destructive
- content detail requires focused reading

Examples already present:

- instance picker
- news detail
- monitor stop/back confirmation

Rules:

1. Modal header must state purpose immediately.
2. Primary and cancel actions must be clearly grouped.
3. Background dimming should reduce distraction but not fully erase app context.
4. Modal content should not exceed comfortable reading width.

## 11.7 Empty States

An empty state should always include:

1. what is empty
2. why it may be empty
3. what the next action is

Avoid generic “No data” style empties.

## 11.8 Progress and Long-running Actions

The launcher has many long-running tasks:

- login
- install
- mod/content install
- update check
- game launch

Rules:

1. Long-running actions need both local progress and global status text.
2. If exact progress is known, show it numerically.
3. If exact progress is unknown, show phase-based language.
4. Users should never wonder whether an action is frozen.

---

## 12. Page-by-Page UX Guidance

## 12.1 Home

Home is a readiness dashboard.

Recommended hierarchy:

1. launcher/account/system status
2. launch module
3. news and server signals
4. secondary detail

Rules:

1. The selected instance and launch CTA are the center of gravity.
2. News should support scanning first, reading second.
3. Server and telemetry sections should remain compact.
4. Launcher update warnings should appear above general browsing content.

## 12.2 Instances

Instances is a library and maintenance page.

Rules:

1. Users must be able to distinguish preset FPSMaster instances from personal/custom ones.
2. Access restriction, update availability, missing package, and ready state must be visible without opening details.
3. Search should filter by name, base version, and version id.
4. Launch and settings should be the dominant row actions.

## 12.3 Install

Install is a guided configuration flow.

Rules:

1. Version selection comes before loader complexity.
2. Snapshots must be visually and semantically lower-confidence than releases.
3. The final summary must answer exactly what will be installed.
4. The install button must become actionable only when the selected configuration is valid.

## 12.4 Content

Content is a multi-state operational page and therefore the most likely place to become visually chaotic.

Rules:

1. Always keep instance context visible.
2. Source selection and content type must be explicit.
3. Installed, update-available, and not-installed states must be instantly distinguishable.
4. Searching and installed-management are different tasks and should remain separated by tabs or panes.
5. World import is a distinct path and should not visually compete with online search.

## 12.5 Account Center

Account Center should feel personal but still operational.

Rules:

1. Identity block should be calm and legible.
2. Progress metrics should be structured, not gamified to the point of clutter.
3. Activity charts should be lightweight and glanceable.
4. Role and membership should be visible, but not louder than identity.

## 12.6 Settings

Settings is currently the densest page and should be treated as a configurable system console.

Rules:

1. Group by user mental model, not by technical implementation.
2. Suggested grouping:
   - Runtime
   - Behavior
   - Theme
   - Background
   - Launcher updates
   - Account/session
3. Preview-oriented controls should show immediate visual feedback.
4. Update management must remain trustworthy and explicit.

## 12.7 Mandatory Update

Mandatory Update is a safety gate.

Rules:

1. Use a single dominant CTA.
2. Clearly explain why access is blocked.
3. Show the target version and update notes.
4. Remove alternative navigation noise.

## 12.8 Monitor

Monitor is a utility surface, not a marketing surface.

Rules:

1. Runtime state, memory, uptime, and PID must be top-level facts.
2. Log viewport should prioritize readability and automatic continuity.
3. Destructive process actions must require confirmation.
4. Visual flourish should be lighter here than on Home.

---

## 13. Feedback, Errors, and Trust

The launcher mediates installation, updates, and process management. Trust is a core UX requirement.

### 13.1 Status Writing Rules

Status messages should be:

- direct
- specific
- phase-aware
- actionable when possible

Preferred:

- “Checking launcher update”
- “Downloading Forge installer”
- “CurseForge distribution is blocked for this file”

Avoid:

- “Something went wrong”
- “Failed”
- “Unknown error” without nearby context

### 13.2 Error Hierarchy

| Level | Presentation |
|---|---|
| Field error | inline under/near field |
| Section error | inside card/panel |
| Action error | attached to button/action group |
| App-blocking error | modal or dedicated blocking page |

### 13.3 Dangerous Actions

Require confirmation for:

- deleting instances
- stopping game process
- closing a critical flow while operation is mid-flight

Do not require confirmation for harmless reversible actions.

---

## 14. Accessibility and Internationalization

## 14.1 Accessibility

Minimum expectations:

1. Keyboard-focus visibility on all controls
2. Sufficient text contrast in dark and light themes
3. Non-color cues for blocked, selected, error, and warning states
4. Click targets comfortable for desktop use
5. Reduced dependence on hover-only disclosure

## 14.2 Internationalization

The launcher is bilingual and desktop-constrained, so layout must tolerate text expansion.

Rules:

1. Avoid fixed-width copy containers when labels may grow in English or Chinese.
2. Badge labels should remain very short.
3. Titles should tolerate line wrapping without collapsing hierarchy.
4. Do not encode Chinese copy directly in component structure unless intentionally local-only.

Current code still contains isolated hard-coded Chinese labels in some page areas. These should be treated as cleanup targets.

---

## 15. Implementation Rules for Frontend Engineers

### 15.1 Token-first styling

When implementing new UI:

1. Use CSS variables from `src/styles.css` first.
2. Only introduce a new token if an existing semantic token cannot express the intent.
3. Avoid scattering repeated raw alpha/hex combinations in JSX.

### 15.2 Component-first composition

If a pattern repeats twice, it should usually become a component or a documented primitive.

Priority candidates for stronger standardization:

- status badge
- section header
- metric tile
- empty state
- inline notice
- segmented tab switch

### 15.3 State-first UI design

Before designing a view, define these states:

1. initial
2. loading
3. empty
4. success
5. partial/disabled
6. error

No component or page should be designed only for the happy path.

### 15.4 Visual debt to avoid growing

Current code shows early signs of consistency drift:

1. repeated raw accent/danger color usage in page JSX
2. similar pills/badges implemented ad hoc
3. some mixed language content embedded in UI
4. utility card patterns repeated without shared abstraction

Future work should reduce this drift, not extend it.

---

## 16. Recommended Next Design-System Refactors

These are not mandatory for every feature, but they are the highest-value cleanup items.

### Priority A

1. Extract `Badge` component with semantic variants
2. Extract `SectionHeader` component shared across pages
3. Extract `MetricTile` component shared by Home / Account / Settings
4. Replace repeated raw accent classes with semantic utility classes or tokenized component props

### Priority B

1. Standardize inline notice / warning / error blocks
2. Standardize search header and filter toolbar pattern
3. Standardize empty state and zero-data messaging
4. Add reduced-motion handling for ambient background effects

### Priority C

1. Separate visual theme tokens from Minecraft-flavor alias tokens more clearly
2. Create a documented “state color matrix” for ready / update / beta / blocked / danger / success
3. Add screenshot examples to this document after the next UI revision

---

## 17. Final Design Standard

Every new FPSMaster launcher UI should pass this test:

1. Can a returning user understand the page in 3 seconds?
2. Is the primary action obvious?
3. Are blocked/pending/ready/error states unambiguous?
4. Does the surface feel coherent with the launcher shell?
5. Are color, radius, spacing, and typography taken from the system instead of improvised?
6. Does the page support repeated use without visual fatigue?

If any answer is “no”, the design is not ready.

