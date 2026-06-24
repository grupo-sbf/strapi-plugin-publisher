'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { registerCronTasks } = require('./cron-tasks');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup({ records, toggleImpl }) {
	const calls = { findArgs: null, order: [] };

	const services = {
		settingsService: { get: () => ({ actions: { syncFrequency: '*/1 * * * *' } }) },
		action: {
			find: async (args) => {
				calls.findArgs = args;
				return { results: records };
			},
		},
		publicationService: {
			toggle: async (record, mode) => {
				calls.order.push(`start:${record.id}`);
				await toggleImpl(record, mode);
				calls.order.push(`end:${record.id}`);
			},
		},
	};

	let captured;
	const strapi = {
		plugin: () => ({ service: (name) => services[name] }),
		cron: { add: (tasks) => (captured = tasks.publisherCronTask.task) },
		log: { error: () => {} },
	};

	global.strapi = strapi;
	registerCronTasks({ strapi });
	return { task: captured, calls };
}

test.afterEach(() => {
	delete global.strapi;
});

test('requests actions ordered by executeAt ascending', async () => {
	const { task, calls } = setup({
		records: [{ id: 1, mode: 'publish', entitySlug: 'api::a.a', entityId: 1 }],
		toggleImpl: async () => {},
	});

	await task();

	assert.deepStrictEqual(calls.findArgs.sort, ['executeAt:asc']);
	assert.deepStrictEqual(calls.findArgs.filters.executeAt.$lte !== undefined, true);
});

test('processes toggles sequentially (awaits each before the next)', async () => {
	const { task, calls } = setup({
		records: [
			{ id: 1, mode: 'publish', entitySlug: 'api::a.a', entityId: 7 },
			{ id: 2, mode: 'unpublish', entitySlug: 'api::a.a', entityId: 7 },
		],
		toggleImpl: async (record) => {
			await delay(record.id === 1 ? 20 : 1);
		},
	});

	await task();

	assert.deepStrictEqual(calls.order, ['start:1', 'end:1', 'start:2', 'end:2']);
});

test('a failing toggle does not abort the rest of the batch', async () => {
	const { task, calls } = setup({
		records: [
			{ id: 1, mode: 'publish', entitySlug: 'api::a.a', entityId: 1 },
			{ id: 2, mode: 'publish', entitySlug: 'api::b.b', entityId: 1 },
		],
		toggleImpl: async (record) => {
			if (record.id === 1) {
				throw new Error('boom');
			}
		},
	});

	await task();

	assert.deepStrictEqual(calls.order, ['start:1', 'start:2', 'end:2']);
});

test('skips a tick while a previous run is still draining', async () => {
	let findCount = 0;
	const services = {
		settingsService: { get: () => ({ actions: { syncFrequency: '*/1 * * * *' } }) },
		action: {
			find: async () => {
				findCount += 1;
				await delay(20);
				return { results: [] };
			},
		},
		publicationService: { toggle: async () => {} },
	};
	let captured;
	const strapi = {
		plugin: () => ({ service: (name) => services[name] }),
		cron: { add: (tasks) => (captured = tasks.publisherCronTask.task) },
		log: { error: () => {} },
	};
	global.strapi = strapi;
	registerCronTasks({ strapi });

	await Promise.all([captured(), captured()]);

	assert.strictEqual(findCount, 1);
});