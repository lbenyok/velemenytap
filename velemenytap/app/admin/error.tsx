"use client";

export default function AdminError({ reset }: { reset: () => void }) {
  return <main className="mx-auto max-w-lg space-y-4 p-8"><h1 className="text-2xl font-semibold">Az adminfelület nem tölthető be</h1><p>Ellenőrizd a kapcsolatot, majd próbáld újra. A zárolás állapotát csak sikeres mentés után tekintsd módosítottnak.</p><button onClick={reset} className="rounded-md border px-4 py-2">Újrapróbálás</button></main>;
}
