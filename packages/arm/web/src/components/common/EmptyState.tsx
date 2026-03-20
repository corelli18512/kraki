export function EmptyState({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center p-12 text-center">
      <span className="text-4xl">{icon}</span>
      <h3 className="mt-3 text-sm font-medium text-text-primary">{title}</h3>
      <p className="mt-1 max-w-xs text-xs text-text-secondary">{description}</p>
    </div>
  );
}
