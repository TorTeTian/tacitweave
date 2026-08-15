import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

test('browser bundle contributes settings and a global temporary-memory badge', () => {
  let moduleRecord
  const registrations = []
  const styles = []
  const context = {
    window: { __ModuleLoader__: { load(record) { moduleRecord = record } } },
    document: {
      head: { appendChild(node) { styles.push(node) } },
      createElement() { return { remove() {} } },
    },
    fetch() { throw new Error('not called during registration') },
  }
  vm.runInNewContext(readFileSync(new URL('../.dsh-plugin/client.js', import.meta.url), 'utf8'), context)
  assert.equal(moduleRecord.id, 'dsh-tacitweave')
  const plugin = moduleRecord.factory(name => {
    assert.equal(name, 'react')
    return { createElement() {} }
  })
  const ctx = {
    effect(setup) { setup() },
    slots: {
      inject(name, setup) {
        assert.ok(['settings.plugins.tab', 'shell.overlay'].includes(name))
        setup()
      },
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
  }
  plugin.apply(ctx)
  assert.equal(styles.length, 1)
  assert.deepEqual({ ...registrations[0].options, inject: undefined }, {
    name: 'settings.plugins.tab', id: 'tacitweave', order: 30, label: registrations[0].options.label, inject: undefined,
  })
  assert.equal(registrations[0].options.label(), 'TacitWeave')
  assert.deepEqual({ ...registrations[1].options, inject: undefined }, {
    name: 'shell.overlay', id: 'tacitweave-memory-badge', order: 30, inject: undefined,
  })
})
