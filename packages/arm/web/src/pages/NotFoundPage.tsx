export function NotFoundPage() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="text-center">
        <img src="/logo.png" alt="Kraki" className="h-16 w-16 object-contain" />
        <h2 className="mt-4 text-lg font-semibold text-text-primary">Page not found</h2>
        <p className="mt-2 text-sm text-text-secondary">
          The page you're looking for doesn't exist.
        </p>
      </div>
    </div>
  );
}
