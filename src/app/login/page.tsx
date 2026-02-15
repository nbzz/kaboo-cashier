import Link from "next/link";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-cyan-50 to-white px-4">
      <section className="w-full max-w-md rounded-3xl border border-cyan-100 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-bold text-slate-900">會員記賬系統</h1>
        <p className="mt-2 text-sm text-slate-500">
          本版本為單設備離線記賬模式，資料保存在本機，並每日首次聯網自動同步備份。
        </p>
        <div className="mt-6">
          <Link
            href="/quick"
            className="block w-full rounded-2xl bg-cyan-700 px-6 py-4 text-center text-lg font-semibold text-white"
          >
            進入系統
          </Link>
        </div>
      </section>
    </main>
  );
}
