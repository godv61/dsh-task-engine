/**
 * Ambient types for the `@deepseek-ai/dsh-client-ui-primitives` baseline external.
 *
 * These components are provided by the DSH shell at runtime (the bundle does not
 * copy them), so this declaration is type-check-only and mirrors the upstream
 * sources the shell compiles. It is intentionally narrowed to the components this
 * plugin renders; it never reaches `lib/client.js` because esbuild does not bundle
 * `.d.ts` files.
 *
 * This file stays a global script (no top-level import/export): the `React` UMD
 * namespace from `@types/react` is then available to the ambient module below,
 * which keeps the `declare module` a fresh declaration rather than an augmentation.
 *
 * @module dsh-task-engine/primitives (ambient)
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'

  export function Button(props: {
    variant?: ButtonVariant
    size?: 'md' | 'sm'
    icon?: React.ReactNode
    className?: string
    children?: React.ReactNode
  } & React.ButtonHTMLAttributes<HTMLButtonElement>): React.ReactElement

  export function Pill(props: {
    active?: boolean
    className?: string
    children?: React.ReactNode
  } & React.ButtonHTMLAttributes<HTMLButtonElement>): React.ReactElement

  export function Input(props: {
    icon?: React.ReactNode
    className?: string
  } & React.InputHTMLAttributes<HTMLInputElement>): React.ReactElement

  export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error'

  export function StateDot(props: {
    state: StateDotState
    size?: number
    className?: string
  }): React.ReactElement

  export interface DisclosureRowProps {
    icon: React.ReactNode
    title: string
    open: boolean
    expandable: boolean
    onToggle: () => void
    expandOnRowClick?: boolean
    previewChevron?: boolean
    keepContentWhenOpen?: boolean
    collapsedContent?: React.ReactNode
    children?: React.ReactNode
    className?: string
    rowClassName?: string
    leadingClassName?: string
    chevronClassName?: string
    titleClassName?: string
  }

  export function DisclosureRow(props: DisclosureRowProps): React.ReactElement

  export interface IconProps {
    size?: number
    className?: string
  }

  export function IconPlusOutline16(props: IconProps): React.ReactElement
  export function IconCloseOutline16(props: IconProps): React.ReactElement
  export function IconCheckOutline16(props: IconProps): React.ReactElement
  export function IconBranchOutline16(props: IconProps): React.ReactElement
  export function IconSettingsOutline16(props: IconProps): React.ReactElement
  export function IconEditOutline16(props: IconProps): React.ReactElement
  export function IconThinkOutline16(props: IconProps): React.ReactElement
  export function IconChevronDownOutline14(props: IconProps): React.ReactElement

  export const IconCloseOutlineRegular: ((props: IconProps) => React.ReactElement) | undefined
  export const IconCheckOutlineRegular: ((props: IconProps) => React.ReactElement) | undefined
  export const IconSettingsOutlineRegular: ((props: IconProps) => React.ReactElement) | undefined

  /** Localized chrome for the Markdown renderer. */
  export interface MarkdownLabels {
    code: { copyLabel: string; copiedLabel: string }
    footnotes: string
  }

  export function MarkdownText(props: {
    text: string
    streaming?: boolean
    labels: MarkdownLabels
  }): React.ReactElement
}
