import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** Synchronous SQLite driver bridge. Upstream SQL, migrations, and transaction boundaries stay intact. */
export default class Database {
  private readonly connection: DatabaseSync;
  private savepoint = 0;
  constructor(file: string, options: { readonly?: boolean; fileMustExist?: boolean } = {}) {
    if (options.fileMustExist && !existsSync(file))
      throw new Error(`SQLite database does not exist: ${file}`);
    this.connection = new DatabaseSync(file, { readOnly: options.readonly ?? false });
    this.connection.exec("PRAGMA busy_timeout = 5000");
  }
  prepare(sql: string) {
    return this.connection.prepare(sql);
  }
  exec(sql: string) {
    this.connection.exec(sql);
    return this;
  }
  close() {
    this.connection.close();
  }
  pragma(sql: string, options: { simple?: boolean } = {}) {
    const rows = this.connection.prepare(`PRAGMA ${sql}`).all();
    return options.simple ? Object.values(rows[0] ?? {})[0] : rows;
  }
  transaction<A extends unknown[], T>(operation: (...args: A) => T) {
    const run = (mode: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE", args: A): T => {
      const nested = this.connection.isTransaction;
      const name = `mixer_transaction_${this.savepoint++}`;
      this.connection.exec(nested ? `SAVEPOINT ${name}` : `BEGIN ${mode}`);
      try {
        const result = operation(...args);
        if (result instanceof Promise)
          throw new TypeError("SQLite transactions must be synchronous.");
        this.connection.exec(nested ? `RELEASE ${name}` : "COMMIT");
        return result;
      } catch (error) {
        if (this.connection.isTransaction) {
          this.connection.exec(nested ? `ROLLBACK TO ${name}` : "ROLLBACK");
          if (nested) this.connection.exec(`RELEASE ${name}`);
        }
        throw error;
      }
    };
    const deferred = (...args: A) => run("DEFERRED", args);
    return Object.assign(deferred, {
      deferred,
      immediate: (...args: A) => run("IMMEDIATE", args),
      exclusive: (...args: A) => run("EXCLUSIVE", args),
    });
  }
}
