export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Parc Auto</h1>
          <p className="text-sm text-muted-foreground">Gestion de parc automobile multi-sociétés</p>
        </div>
        {children}
      </div>
    </main>
  );
}
