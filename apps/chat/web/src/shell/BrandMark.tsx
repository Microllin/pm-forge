/**
 * PM-Forge 的标志：一块砧台。上面是「台面」（实心），下面是「腰」和「底座」（线条）。
 * 锻造厂的意象——零散的想法在这里被锤成可交付的东西。
 *
 * 用 currentColor：放在紫底徽章上是白色，放在别处跟着文字色走。
 */
export function BrandMark({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 9h12l4-3v5l-4 2H4z" fill="currentColor" />
      <path
        d="M8 13v4h8v-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <path
        d="M6 20h12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
