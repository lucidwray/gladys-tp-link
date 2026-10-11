import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { findOnOffFeature, findBrightnessFeature } from '../src/deviceLookup.js';

const onOff = {
  external_id: 'ext:test:plug:P1:on-off',
  category: DEVICE_FEATURE_CATEGORIES.SWITCH,
  type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
};
const brightness = {
  external_id: 'ext:test:plug:P1:brightness',
  category: DEVICE_FEATURE_CATEGORIES.SWITCH,
  type: DEVICE_FEATURE_TYPES.SWITCH.DIMMER,
};
const sensor = { external_id: 'ext:test:plug:P1:temp', category: 'temperature-sensor', type: 'decimal' };
const lightOnOff = {
  external_id: 'ext:test:bulb:B1:on-off',
  category: DEVICE_FEATURE_CATEGORIES.LIGHT,
  type: DEVICE_FEATURE_TYPES.LIGHT.BINARY,
};

test('findOnOffFeature finds the binary switch of a legacy plug', () => {
  assert.equal(findOnOffFeature({ features: [onOff] }), onOff);
});

test('findOnOffFeature finds the binary light of a bulb', () => {
  assert.equal(findOnOffFeature({ features: [lightOnOff] }), lightOnOff);
});

test('findOnOffFeature ignores the dimmer brightness, even when it comes first', () => {
  assert.equal(findOnOffFeature({ features: [brightness, onOff] }), onOff);
});

test('findOnOffFeature returns undefined when there is no binary control', () => {
  assert.equal(findOnOffFeature({ features: [sensor] }), undefined);
  assert.equal(findOnOffFeature({ features: [brightness] }), undefined);
  assert.equal(findOnOffFeature({ features: [] }), undefined);
  assert.equal(findOnOffFeature({}), undefined);
  assert.equal(findOnOffFeature(undefined), undefined);
});

test('findBrightnessFeature finds the dimmer feature of a dimmer plug', () => {
  assert.equal(findBrightnessFeature({ features: [onOff, brightness] }), brightness);
});

test('findBrightnessFeature returns undefined for a device without a dimmer', () => {
  assert.equal(findBrightnessFeature({ features: [onOff] }), undefined);
  assert.equal(findBrightnessFeature({}), undefined);
  assert.equal(findBrightnessFeature(undefined), undefined);
});
