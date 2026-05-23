# Citation Labs App Design Brief

## For Small SaaS / Internal Tool Development

## Goal

Build the app so it feels like a Citation Labs product: professional, data-driven, enterprise-ready, and useful without feeling heavy or generic. The interface should look like an operational SEO / link-building tool used by enterprise teams, not a marketing landing page or a playful startup dashboard.

The app should prioritize clarity, scanability, and confidence. Users should immediately understand what actions are available, what the current status is, and where important data lives.

## Brand Feel

Citation Labs should feel:

- Professional, but not stiff
- Analytical and scientific
- Confident and results-oriented
- Clean, structured, and enterprise-grade
- Approachable enough for daily use

Avoid anything that feels overly trendy, playful, decorative, or generic SaaS.

The design language should be blocky, clean, and data-forward. Use solid sections, clear cards, strong headings, visible hierarchy, and restrained accents.

## Core Visual Direction

Use the existing Citation Labs style guide as the visual source of truth.

The app should resemble the provided style guide screenshots:

- White page background
- Enterprise Blue headings and navigation
- Ice Blue secondary surfaces
- Yellow used sparingly for primary CTAs and key highlights
- Light bordered cards
- Dark blue panels only where stronger emphasis is needed
- Compact but readable data tables
- Clear form states and system feedback
- Slightly squared corners, not pill-shaped UI
- Strong uppercase headings for major sections

The interface should feel useful and built for work.

## Color System

### Primary Colors

| Name            | Hex       | Usage                                                                                                                        |
| --------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Enterprise Blue | `#104590` | Main brand color. Use for headings, primary navigation, table headers, selected states, key icons, and strong text emphasis. |
| Action Yellow   | `#FFB800` | Primary CTA color. Use sparingly for high-value actions and key highlights.                                                  |

### Secondary Colors

| Name      | Hex       | Usage                                                                                        |
| --------- | --------- | -------------------------------------------------------------------------------------------- |
| Deep Navy | `#0D2B5B` | Footer, dark panels, inverse sections, and high-emphasis containers.                         |
| Ice Blue  | `#E6EFF8` | Soft backgrounds, alternating table rows, info blocks, subtle card fills, and page sections. |

### Functional Colors

| Name    | Hex       | Usage                                                  |
| ------- | --------- | ------------------------------------------------------ |
| Success | `#059669` | Positive states, completed tasks, confirmations.       |
| Warning | `#D97706` | Caution states, pending actions, credit warnings.      |
| Error   | `#EF4444` | Validation errors, destructive actions, failed states. |
| Info    | `#104590` | Informational messages and system tips.                |

### Color Rules

- Enterprise Blue should dominate the interface.
- Yellow should be reserved for important CTAs and highlights.
- Do not use yellow as a general decoration color.
- Avoid purple gradients, rounded decorative blobs, beige palettes, neon colors, or generic SaaS rainbow styling.
- Most screens should use white, blue, navy, ice blue, slate gray, and small yellow accents.

## Typography

Use Inter, Geist, or the system sans-serif stack.

Preferred stack:

```css
font-family:
  Inter,
  Geist,
  -apple-system,
  BlinkMacSystemFont,
  "Segoe UI",
  Roboto,
  sans-serif;
```

### Heading Style

Major headings should be bold, confident, and often uppercase.

| Element         | Size                            | Weight | Style                   |
| --------------- | ------------------------------- | ------ | ----------------------- |
| H1              | 48-64px desktop, 36-44px mobile | 800    | Uppercase preferred     |
| H2              | 30-36px                         | 700    | Uppercase preferred     |
| H3              | 20-24px                         | 700    | Title case or uppercase |
| Body            | 16-18px                         | 400    | Sentence case           |
| Small UI text   | 13-14px                         | 500    | Sentence case           |
| Stats / numbers | 48-64px                         | 700    | Large, bold, scannable  |

### Typography Rules

- Use Enterprise Blue for headings.
- Use slate gray for body copy.
- Avoid thin headline weights.
- Avoid oversized type inside compact app panels.
- Use large bold numbers for stats, metrics, and KPIs.
- Body text should use comfortable line height, usually `1.5` to `1.75`.

## Layout Principles

Use an 8px spacing system.

| Token | Value | Usage                     |
| ----- | ----- | ------------------------- |
| `xs`  | 4px   | Tight gaps                |
| `sm`  | 8px   | Compact UI spacing        |
| `md`  | 16px  | Default component spacing |
| `lg`  | 24px  | Card padding              |
| `xl`  | 32px  | Section spacing           |
| `2xl` | 48px  | Large section spacing     |
| `3xl` | 64px  | Major page spacing        |

### Page Layout

- Max content width: 1200-1280px.
- Page padding: 24-32px desktop, 16px mobile.
- Use a clean grid system.
- Prefer full-width app sections over floating decorative cards.
- Cards should organize real content, not decorate the page.
- Long-form reading content should use a comfortable max width around 720px.

### Shape

- Border radius should generally be 4-8px.
- Buttons should be slightly rounded, not pill-shaped.
- Cards should feel crisp and structured.

## App Shell

The app should have a practical SaaS layout.

Recommended structure:

- Top header with Citation Labs branding.
- Optional horizontal navigation or left sidebar depending on app complexity.
- Main content area with page title, description, and primary actions.
- Data, forms, and workflows grouped into clear sections.
- Footer only if needed.

### Header

Use:

- White background.
- Subtle bottom border.
- Citation Labs logo or compact brand mark.
- Enterprise Blue text.
- Active nav state using Ice Blue or a blue underline.

Avoid oversized marketing-style navigation.

## Buttons

### Primary Button

Use for the most important action on the screen.

- Background: `#FFB800`
- Text: white or Deep Navy if contrast is stronger
- Font: bold, uppercase, 14-16px
- Padding: 12-16px vertical, 24-32px horizontal
- Radius: 2-4px
- Hover: slightly darker yellow, subtle lift
- Active: slight scale down

Example labels:

- `CREATE CAMPAIGN`
- `RUN REPORT`
- `EXPORT`
- `SAVE CHANGES`

### Secondary Button

Use for supporting actions.

- White or transparent background.
- Enterprise Blue border.
- Enterprise Blue text.
- Hover: Ice Blue background.

### Dark Background Button

On Deep Navy or Enterprise Blue backgrounds:

- Use white outline buttons.
- Use yellow only for the primary action.

## Cards and Panels

### Light Cards

Use for normal app content.

- Background: white
- Border: `#E2E8F0`
- Radius: 6-8px
- Padding: 20-24px
- Hover only when clickable

### Dark Cards

Use sparingly for high-emphasis sections.

- Background: Enterprise Blue or Deep Navy
- Text: white
- Icons or accents: Action Yellow
- Good for summaries, important status, or featured actions

### Card Rules

- Do not nest cards inside cards unless absolutely necessary.
- Do not overuse shadows.
- Prefer borders and spacing for structure.
- Hover lift should only appear on interactive cards.

## Forms

Forms should feel precise and trustworthy.

### Inputs

- Border: `#E2E8F0`
- Radius: 4-6px
- Height: 40-44px
- Focus border/ring: Enterprise Blue
- Labels: small, bold, slate or blue
- Helper text: slate gray

### Validation

- Error: red border, red helper text, error icon if available.
- Success: blue or green confirmation state.
- Warning: amber left border or tinted warning block.
- Do not rely on color alone. Use text labels or icons for state.

## Tables and Data Views

Tables should look like the spreadsheet style guide.

Use:

- Enterprise Blue table headers
- White rows
- Ice Blue alternating rows when helpful
- Clear status badges
- Compact but readable spacing
- Right-aligned numeric values
- Bold important metrics

### Table Header

- Background: `#104590`
- Text: white
- Font weight: 700
- Height: 44-52px

### Status Badges

Use squared badges, not pills.

| Status            | Color     |
| ----------------- | --------- |
| Complete / Active | `#059669` |
| In Progress       | `#FFB800` |
| Pending           | `#E6EFF8` |
| Blocked           | `#DC2626` |
| Not Started       | `#F1F5F9` |

Badges should have strong contrast and short labels.

## Spreadsheet-Inspired Utility Colors

If the app includes planning, workflow, task duration, or spreadsheet-like views, use the following supporting colors from the style guide.

### Time-to-Complete Scale

| Label   | Background | Text      | Usage                         |
| ------- | ---------- | --------- | ----------------------------- |
| Ready   | `#059669`  | `#FFFFFF` | Task is ready, no time needed |
| 2 min   | `#A7F3D0`  | `#065F46` | Quick task, minimal effort    |
| 5 min   | `#FEF3C7`  | `#92400E` | Short task, getting attention |
| 10 min  | `#FED7AA`  | `#9A3412` | Moderate time needed          |
| 20+ min | `#FEE2E2`  | `#991B1B` | Significant time required     |

### Priority Scale

| Priority | Color     |
| -------- | --------- |
| Critical | `#991B1B` |
| High     | `#DC2626` |
| Medium   | `#F59E0B` |
| Low      | `#104590` |
| None     | `#E6EFF8` |

Use these scales consistently. Do not invent new status colors without checking the brand system first.

## Alerts and Feedback

Use system feedback blocks for important state changes.

Preferred style:

- Light tinted background
- 4px left border in state color
- Icon on the left
- Bold title
- Short description

Examples:

- Campaign Started
- Report Generated
- Low Credits
- URL Validation Failed

## Charts and Metrics

Charts should be clean and brand-aligned.

Use:

- Enterprise Blue for primary series.
- Ice Blue or lighter blues for secondary series.
- Yellow only for highlights or key thresholds.
- Light gray grid lines.
- No rainbow palettes unless absolutely necessary.

Stats should be large, bold, and blue.

Example:

```text
195,468
links built
```

## Icons

Use Lucide React if available.

Icon style:

- Outline icons
- 1.5-2px stroke
- 16px inline
- 20px buttons
- 24px cards
- Enterprise Blue on light backgrounds
- White or yellow on dark backgrounds

Avoid filled, cartoonish, or mismatched icon sets.

## Motion

Use motion sparingly.

Approved motion:

- Button hover lift: `translateY(-2px)`
- Card hover lift for clickable cards only
- Focus ring transition
- Short fade/slide page transitions

Duration:

- 150-300ms
- `ease-out` or `ease-in-out`

Avoid bouncy, playful, or decorative animation.

## Accessibility Requirements

The app should meet WCAG AA basics.

Required:

- Visible keyboard focus states.
- Proper labels for inputs.
- Semantic buttons and links.
- Good color contrast.
- Do not communicate status by color alone.
- Tables should have real headers.
- Icons-only buttons need accessible labels.
- Mobile layouts should not overflow horizontally.

## Developer Implementation Notes

Use CSS variables or Tailwind tokens for the brand system.

Recommended CSS variables:

```css
:root {
  --cl-blue: #104590;
  --cl-navy: #0d2b5b;
  --cl-yellow: #ffb800;
  --cl-ice: #e6eff8;
  --cl-success: #059669;
  --cl-warning: #d97706;
  --cl-error: #ef4444;
  --cl-slate: #475569;
  --cl-border: #e2e8f0;
}
```

Recommended default component decisions:

- Buttons: squared, bold, uppercase.
- Cards: white, bordered, 6-8px radius.
- Tables: blue headers, compact rows.
- Forms: clear labels, visible focus states.
- Alerts: left-border system blocks.
- Navigation: clean, blue, understated.

## What To Avoid

Do not use:

- Pill buttons everywhere.
- Purple/blue gradients.
- Decorative blobs or abstract background shapes.
- Generic stock photos.
- Overly rounded cards.
- Thin fonts for headings.
- Excessive shadows.
- Too much yellow.
- Marketing landing page layouts for app screens.
- Cute or playful visual language.

## Acceptance Checklist

Before handing off the app, confirm:

- The app uses Enterprise Blue as the dominant brand color.
- Yellow appears only on primary CTAs or key highlights.
- Major headings are bold and confident.
- Tables and forms match the Citation Labs style guide.
- Status badges use the approved colors.
- Cards are clean, bordered, and not overly rounded.
- Buttons are uppercase, bold, and squared.
- Focus states are visible.
- Mobile layouts do not overflow.
- The app feels like an enterprise SEO operations tool.
