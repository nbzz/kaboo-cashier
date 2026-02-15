import AppNav from "@/components/app-nav";
import BackupRunner from "@/components/backup-runner";

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-slate-50">
      <BackupRunner />
      <AppNav />
      <main className="mx-auto w-full max-w-6xl px-4 py-5 md:px-8">{children}</main>
    </div>
  );
}
