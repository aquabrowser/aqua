// Lets the tests import app modules whose own imports leave out the ".ts"
// extension (the bundler resolves those; Node's type stripping does not).
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../')
      if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !relative || /\.[cm]?[jt]s$/.test(specifier)) throw err
      return next(`${specifier}.ts`, context)
    }
  }
})
