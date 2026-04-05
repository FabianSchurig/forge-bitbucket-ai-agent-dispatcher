/**
 * Jest manual mock for @forge/resolver.
 *
 * Provides a minimal Resolver class whose define() and getDefinitions()
 * methods let tests verify resolver registration without real Forge runtime.
 */

class Resolver {
  private readonly _definitions: Record<
    string,
    (req: { payload: unknown }) => Promise<unknown>
  > = {};

  define(
    key: string,
    handler: (req: { payload: unknown }) => Promise<unknown>,
  ): void {
    this._definitions[key] = handler;
  }

  getDefinitions(): (req: { key: string; payload: unknown }) => Promise<unknown> {
    return async (req: { key: string; payload: unknown }) => {
      const fn = this._definitions[req.key];
      if (!fn) {
        throw new Error(`No resolver defined for key: ${req.key}`);
      }
      return fn({ payload: req.payload });
    };
  }
}

export default Resolver;
