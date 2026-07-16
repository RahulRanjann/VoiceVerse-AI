# Milestone 1 dashboard design system

The implementation reference is
[`milestone-1-dashboard-concept.png`](./milestone-1-dashboard-concept.png). It is a
design target, not a bitmap asset to embed in the product.

## Product hierarchy

1. Persistent studio navigation
2. Search and the global **Upload movie** action
3. A single start panel for the primary task
4. A compact recent-projects table
5. A focused upload dialog that preserves the dashboard context

The dashboard intentionally has no fabricated business metrics. Operational data
appears only when it helps a user decide what to do next.

## Copy lock

- Product: `VoiceVerse`
- Page title: `Your dubbing studio`
- Page description: `Create natural, character-consistent versions of every story.`
- Primary action: `Upload movie`
- Start title: `Bring a new story to life`
- Start description: `Upload an MP4 to begin a secure, resumable dubbing project.`
- Upload description: `Create a project and transfer the original file directly to secure storage.`
- Security note: `Files stay quarantined until malware scanning is complete.`

## Tokens

| Token              | Intent                                              |
| ------------------ | --------------------------------------------------- |
| `background`       | Near-black studio canvas                            |
| `card` / `surface` | Graphite working surfaces                           |
| `primary`          | Restrained violet for the dominant action and focus |
| `border`           | Cool, low-contrast hairlines                        |
| `muted-foreground` | Supporting copy and metadata                        |
| `success`          | Clean/ready states only                             |
| `warning`          | Active processing and recoverable attention         |

Typography uses Geist with a compact product-software scale. Corners are modest,
shadows are soft, and animation communicates state rather than decoration.

## Component inventory

- App shell, responsive navigation sheet, workspace switcher
- Command-search control and keyboard hint
- Project table with semantic status badges
- Upload dialog using `FieldGroup` and `Field`
- Language selects, MP4 drop zone, progress, retry/cancel controls
- Avatar menu, alerts, skeletons, and Sonner notifications

All controls retain visible keyboard focus. The table becomes a stacked project list
below tablet width; the navigation becomes a sheet. Reduced-motion preferences remove
non-essential transitions.
