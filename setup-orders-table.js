import "dotenv/config";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    "DATABASE_URL is missing. Add the Supabase PostgreSQL connection string to the local .env file."
  );
  process.exitCode = 1;
} else {
  let databaseUrl;

  try {
    databaseUrl = new URL(connectionString);
  } catch {
    console.error("DATABASE_URL is not a valid PostgreSQL URL.");
    process.exitCode = 1;
  }

  if (databaseUrl && !["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
    console.error("DATABASE_URL must use the postgres:// or postgresql:// protocol.");
    process.exitCode = 1;
    databaseUrl = undefined;
  }

  if (databaseUrl) {
    // Keep TLS behavior aligned with server.js and avoid pg's sslmode override.
    databaseUrl.searchParams.delete("sslmode");

    const sslEnabled = String(process.env.DATABASE_SSL ?? "true").toLowerCase() !== "false";
    const sslCa = process.env.DATABASE_SSL_CA || "";
    const ssl = sslEnabled
      ? {
          rejectUnauthorized: true,
          ...(sslCa ? { ca: sslCa.replace(/\\n/g, "\n") } : {})
        }
      : false;

    const pool = new pg.Pool({
      connectionString: databaseUrl.toString(),
      ssl,
      max: 1,
      connectionTimeoutMillis: 10_000
    });

    let client;

    try {
      client = await pool.connect();
      await client.query("BEGIN");

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.orders (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id bigint REFERENCES public.users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          product_name text NOT NULL,
          amount bigint NOT NULL CHECK (amount > 0),
          customer_contact text NOT NULL,
          tracking_code text,
          status text NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'paid', 'delivered', 'rejected', 'cancelled')),
          delivery_code text
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS orders_status_created_at_idx
        ON public.orders (status, created_at DESC);
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS orders_tracking_code_idx
        ON public.orders (tracking_code)
        WHERE tracking_code IS NOT NULL;
      `);

      await client.query(`
        ALTER TABLE public.orders
        ADD COLUMN IF NOT EXISTS user_id bigint REFERENCES public.users(id) ON DELETE SET NULL;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS orders_user_created_at_idx
        ON public.orders (user_id, created_at DESC);
      `);

      await client.query("ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;");
      await client.query("COMMIT");

      console.log("Success: public.orders, its indexes, and row-level security are ready.");
    } catch (error) {
      if (client) {
        await client.query("ROLLBACK").catch(() => {});
      }
      console.error(`Failed to initialize public.orders: ${error.message}`);
      process.exitCode = 1;
    } finally {
      client?.release();
      await pool.end();
    }
  }
}
