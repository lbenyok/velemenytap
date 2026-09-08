export function PublicMessageScreen({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="public-feedback flex min-h-svh flex-col items-center justify-center gap-2 bg-[var(--pf-bg)] px-6 text-center text-[var(--pf-ink)]">
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      <p className="max-w-xs text-sm text-[var(--pf-ink-muted)]">{description}</p>
    </div>
  );
}
