export function FieldError({ errors, name }: { errors: Record<string, string[]> | undefined; name: string }) {
  const messages = errors?.[name];
  if (!messages || messages.length === 0) return null;
  return (
    <p id={`${name}-error`} role="alert" className="text-sm text-destructive">
      {messages.join(' ')}
    </p>
  );
}
