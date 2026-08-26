import { describe, expect, it } from 'vitest'
import { credentialFromEnvironment } from '../src/cli/env.js'

describe('environment credential selection', () => {
  it('prefers the exact credential name', () => {
    expect(
      credentialFromEnvironment(
        { INKBOX_API_KEY: 'exact', INKBOX_API_KEY_TEAM: 'variant' },
        'INKBOX_API_KEY',
      ),
    ).toBe('exact')
  })

  it('accepts one explicitly scoped variant', () => {
    expect(credentialFromEnvironment({ INKBOX_API_KEY_TEAM: 'variant' }, 'INKBOX_API_KEY')).toBe('variant')
  })

  it('requires an exact selection when variants are ambiguous', () => {
    expect(() =>
      credentialFromEnvironment({ INKBOX_API_KEY_ONE: 'one', INKBOX_API_KEY_TWO: 'two' }, 'INKBOX_API_KEY'),
    ).toThrow(/Multiple INKBOX_API_KEY_\*/)
  })

  it('selects a named scoped variant without exposing its value', () => {
    expect(
      credentialFromEnvironment(
        { INKBOX_API_KEY_ONE: 'one', INKBOX_API_KEY_TWO: 'two' },
        'INKBOX_API_KEY',
        'INKBOX_API_KEY_TWO',
      ),
    ).toBe('two')
  })

  it('returns undefined when no credential is present', () => {
    expect(credentialFromEnvironment({}, 'INKBOX_API_KEY')).toBeUndefined()
  })
})
