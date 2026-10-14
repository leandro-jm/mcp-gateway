/** Cube mark + wordmark, same drawing as the Admin UI topbar (apps/admin-ui/src/components/Shell.tsx). */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <span className="logo">
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <path d="M16 3 28 9.5v13L16 29 4 22.5v-13z" fill="none" stroke="currentColor" strokeWidth="2.6" />
        <path d="M4 9.5 16 16l12-6.5M16 16v13" fill="none" stroke="currentColor" strokeWidth="2.6" />
      </svg>
      <span>MCP·GW</span>
    </span>
  );
}
