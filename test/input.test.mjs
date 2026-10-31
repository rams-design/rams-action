import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readInput } from '../input.mjs';

test('reads the hyphenated name GitHub actually sets', () => {
  assert.equal(readInput({ 'INPUT_API-KEY': 'rams_x' }, 'api-key'), 'rams_x');
  assert.equal(readInput({ 'INPUT_SWIFTUI-BUILD-TIMEOUT': '20' }, 'swiftui-build-timeout', '15'), '20');
});
test('falls back to the underscore form', () => {
  assert.equal(readInput({ INPUT_API_KEY: 'rams_y' }, 'api-key'), 'rams_y');
});
test('hyphen form wins when both are set', () => {
  assert.equal(readInput({ 'INPUT_FAIL-ON': 'serious', INPUT_FAIL_ON: 'critical' }, 'fail-on'), 'serious');
});
test('missing or empty gives the default', () => {
  assert.equal(readInput({}, 'mode', 'pr'), 'pr');
  assert.equal(readInput({ INPUT_MODE: '' }, 'mode', 'pr'), 'pr');
  assert.equal(readInput({}, 'api-key'), undefined);
});
