'use strict';

const { getPluginService } = require('../utils/getPluginService');

module.exports = {
	registerCronTasks: ({ strapi }) => {
		const settings = getPluginService('settingsService').get();

		// Guards against a slow batch overlapping the next tick. Without it, two
		// cron runs could process actions concurrently and re-introduce the
		// publish/unpublish ordering race the sequential loop below prevents.
		let isRunning = false;

		// create cron check
		strapi.cron.add({
			publisherCronTask: {
				options: {
					rule: settings.actions.syncFrequency,
				},
				task: async () => {
					if (isRunning) {
						return;
					}
					isRunning = true;

					try {
						// fetch all actions that have passed, oldest first so
						// publish-then-unpublish for the same entity is applied in
						// chronological order
						const records = await getPluginService('action').find({
							filters: {
								executeAt: {
									$lte: Date.now(),
								},
							},
							sort: ['executeAt:asc'],
						});

						// Process actions sequentially. Each toggle awaits
						// entityService.update, whose afterUpdate lifecycle drives the
						// downstream sync (e.g. content-cache-api PUT on publish / DELETE
						// on unpublish). Awaiting serializes those writes so they land in
						// order; firing toggles concurrently let a later PUT overtake an
						// earlier DELETE, leaving stale published documents in the cache.
						for (const record of records.results) {
							try {
								await getPluginService('publicationService').toggle(record, record.mode);
							} catch (error) {
								// Do not let one failing action abort the rest of the batch.
								strapi.log.error(
									`[publisher] failed to ${record.mode} ${record.entitySlug}:${record.entityId} (action ${record.id}): ${error.message}`
								);
							}
						}
					} finally {
						isRunning = false;
					}
				},
			},
		});
	},
};
