#!/usr/bin/env node
// Publishes every post as a site.standard.document record on AT Protocol,
// updates records whose post changed, and deletes records for posts that no
// longer exist. Safe to run repeatedly: each post's record key is derived
// from the post (see lib/standard-site.js), so reruns update, never duplicate.
//
// Usage:
//   node scripts/standard-site-sync.js --init     create the publication record (once)
//   node scripts/standard-site-sync.js            sync all posts
//   node scripts/standard-site-sync.js --dry-run  show what would change
//
// Environment:
//   ATP_IDENTIFIER    handle or DID of the account that owns the records
//   ATP_APP_PASSWORD  an app password for that account
//   ATP_SERVICE       PDS or entryway URL (default https://bsky.social)
//
// The records are written to ATP_IDENTIFIER's repository, so that account is
// the author. Add co-authors to a post with "@@ Contributors=did:plc:…, did:plc:…".

var fs = require('fs');
var path = require('path');
var AtpAgent = require('@atproto/api').AtpAgent;
var camel = require('../camel');
var standardSite = require('../lib/standard-site');
var _ = require('underscore');

var args = process.argv.slice(2);
var dryRun = args.includes('--dry-run');
var init = args.includes('--init');

// Document fields this script doesn't manage; kept as-is on update.
var preservedFields = ['bskyPostRef', 'coverImage', 'tags', 'labels', 'links'];

function log(message) {
	console.log('[standard.site] ' + message);
}

function loadSiteMetadata() {
	var data = fs.readFileSync(path.join(camel.templateRoot, 'defaultTags.html'), {encoding: 'UTF8'});
	camel.setSiteMetadata(data);
	return camel.getSiteMetadata();
}

// Reads every published post the way camel.js renders it.
function collectPosts(siteMetadata) {
	var now = new Date();
	return fs.readdirSync(camel.postsRoot, { recursive: true })
		.map(function (file) { return camel.postsRoot + file; })
		.filter(function (file) { return camel.postRegex.test(file) && file.endsWith('.md'); })
		.map(function (file) {
			var lines = camel.getLinesFromPost(file);
			var metadata = camel.parseMetadata(lines.metadata);
			metadata.relativeLink = camel.externalFilenameForFile(file);
			var publishedAt = standardSite.publishedAtFor(metadata, file, camel.utcOffset);
			// parseMetadata escapes quotes and fills in the site-wide default description.
			var description = (metadata.Description || '').replace(/&quot;/g, '"');
			var contributors = (metadata.Contributors || '').split(',')
				.map(function (did) { return did.trim(); })
				.filter(function (did) { return did.length > 0; });

			return {
				file: file,
				publishedAt: publishedAt,
				rkey: standardSite.documentRkey(publishedAt, metadata.relativeLink),
				record: standardSite.buildDocument({
					publicationUri: siteMetadata.StandardSitePublication.trim(),
					title: metadata.Title,
					path: metadata.relativeLink,
					publishedAt: publishedAt,
					description: description === (siteMetadata.Description || '').replace(/&quot;/g, '"') ? '' : description,
					contributors: contributors,
					markdown: camel.performMetadataReplacements(metadata, lines.body),
					html: camel.performMetadataReplacements(metadata, camel.renderMarkdown(lines.body))
				})
			};
		})
		.filter(function (post) { return post.publishedAt <= now; });
}

// Record equality, ignoring key order and updatedAt.
function canonical(value) {
	if (Array.isArray(value)) {
		return '[' + value.map(canonical).join(',') + ']';
	}
	if (value && typeof(value) === 'object') {
		return '{' + Object.keys(value).filter(function (key) { return key !== 'updatedAt'; }).sort().map(function (key) {
			return JSON.stringify(key) + ':' + canonical(value[key]);
		}).join(',') + '}';
	}
	return JSON.stringify(value);
}

async function listAll(agent, did, collection) {
	var records = [];
	var cursor;
	do {
		var response = await agent.com.atproto.repo.listRecords({ repo: did, collection: collection, limit: 100, cursor: cursor });
		records = records.concat(response.data.records);
		cursor = response.data.cursor;
	} while (cursor);
	return records;
}

async function login() {
	if (!process.env.ATP_IDENTIFIER || !process.env.ATP_APP_PASSWORD) {
		return null;
	}
	var agent = new AtpAgent({ service: process.env.ATP_SERVICE || 'https://bsky.social' });
	await agent.login({ identifier: process.env.ATP_IDENTIFIER, password: process.env.ATP_APP_PASSWORD });
	return agent;
}

async function createPublication(agent, siteMetadata) {
	if (standardSite.parseAtUri(siteMetadata.StandardSitePublication)) {
		throw new Error('templates/defaultTags.html already has StandardSitePublication=' + siteMetadata.StandardSitePublication);
	}
	var record = standardSite.buildPublication(siteMetadata.SiteTitle, siteMetadata.SiteRoot);
	var response = await agent.com.atproto.repo.createRecord({
		repo: agent.session.did,
		collection: standardSite.PUBLICATION_COLLECTION,
		record: record
	});
	log('Created publication ' + response.data.uri);
	log('Add this line to templates/defaultTags.html, then deploy and run a sync:');
	console.log('@@ StandardSitePublication=' + response.data.uri);
}

async function sync(agent, siteMetadata) {
	var publicationUri = siteMetadata.StandardSitePublication.trim();
	var publication = standardSite.parseAtUri(publicationUri);
	if (agent && publication.did !== agent.session.did) {
		throw new Error('StandardSitePublication belongs to ' + publication.did + ' but ATP_IDENTIFIER is ' + agent.session.did);
	}

	var posts = collectPosts(siteMetadata);
	var problems = [];
	var seen = {};
	posts.forEach(function (post) {
		standardSite.validateDocument(post.record, post.rkey).forEach(function (error) {
			problems.push(post.file + ': ' + error);
		});
		if (seen[post.rkey]) {
			problems.push(post.file + ': same record key as ' + seen[post.rkey]);
		}
		seen[post.rkey] = post.file;
	});
	if (problems.length > 0) {
		throw new Error('Not publishing; fix these first:\n  ' + problems.join('\n  '));
	}

	if (!agent) {
		log(posts.length + ' posts are valid. Set ATP_IDENTIFIER and ATP_APP_PASSWORD to publish them.');
		return;
	}

	// Keep the publication record's name and url in step with the site.
	var publicationRecord = standardSite.buildPublication(siteMetadata.SiteTitle, siteMetadata.SiteRoot);
	var existingPublication = await agent.com.atproto.repo.getRecord({
		repo: publication.did, collection: standardSite.PUBLICATION_COLLECTION, rkey: publication.rkey
	});
	var mergedPublication = Object.assign({}, existingPublication.data.value, publicationRecord);
	if (canonical(mergedPublication) !== canonical(existingPublication.data.value)) {
		log((dryRun ? 'Would update' : 'Updating') + ' publication ' + publicationUri);
		if (!dryRun) {
			await agent.com.atproto.repo.putRecord({
				repo: publication.did, collection: standardSite.PUBLICATION_COLLECTION, rkey: publication.rkey,
				record: mergedPublication, swapRecord: existingPublication.data.cid
			});
		}
	}

	var existing = {};
	(await listAll(agent, publication.did, standardSite.DOCUMENT_COLLECTION)).forEach(function (record) {
		if (record.value.site === publicationUri) {
			existing[standardSite.parseAtUri(record.uri).rkey] = record;
		}
	});

	var counts = { created: 0, updated: 0, unchanged: 0, deleted: 0 };
	for (var i = 0; i < posts.length; i++) {
		var post = posts[i];
		var current = existing[post.rkey];
		delete existing[post.rkey];
		var record = post.record;
		if (current) {
			// Keep fields this script never sets but other tools may have added.
			record = Object.assign(_.pick(current.value, preservedFields), post.record);
			if (canonical(record) === canonical(current.value)) {
				counts.unchanged += 1;
				continue;
			}
			record.updatedAt = new Date().toISOString();
		}
		counts[current ? 'updated' : 'created'] += 1;
		log((dryRun ? 'Would ' : '') + (current ? 'update ' : 'create ') + post.rkey + ' ' + post.record.path);
		if (!dryRun) {
			await agent.com.atproto.repo.putRecord({
				repo: publication.did, collection: standardSite.DOCUMENT_COLLECTION, rkey: post.rkey,
				record: record, swapRecord: current ? current.cid : null
			});
		}
	}

	// Whatever is left belongs to this publication but has no post: deleted,
	// renamed, or re-dated posts.
	var orphans = Object.keys(existing);
	if (orphans.length > 0 && posts.length === 0) {
		throw new Error('Found no posts but ' + orphans.length + ' published records; refusing to delete them all.');
	}
	for (var j = 0; j < orphans.length; j++) {
		counts.deleted += 1;
		log((dryRun ? 'Would delete ' : 'Delete ') + orphans[j] + ' ' + existing[orphans[j]].value.path);
		if (!dryRun) {
			await agent.com.atproto.repo.deleteRecord({
				repo: publication.did, collection: standardSite.DOCUMENT_COLLECTION, rkey: orphans[j],
				swapRecord: existing[orphans[j]].cid
			});
		}
	}

	log((dryRun ? 'Dry run: ' : '') + counts.created + ' created, ' + counts.updated + ' updated, ' +
		counts.unchanged + ' unchanged, ' + counts.deleted + ' deleted.');
}

async function main() {
	var siteMetadata = loadSiteMetadata();
	var configured = standardSite.parseAtUri(siteMetadata.StandardSitePublication);
	var agent;

	if (init) {
		if (/^https?:\/\/(localhost|127\.0\.0\.1)\b/.test(siteMetadata.SiteRoot || '')) {
			throw new Error('Set SiteRoot in templates/defaultTags.html to your public URL first (it is ' + siteMetadata.SiteRoot + ').');
		}
		agent = await login();
		if (!agent) {
			throw new Error('--init needs ATP_IDENTIFIER and ATP_APP_PASSWORD.');
		}
		await createPublication(agent, siteMetadata);
		return;
	}
	if (!configured) {
		// Not set up; don't fail deploys of sites that don't use this.
		log('StandardSitePublication is not set in templates/defaultTags.html; skipping. Run with --init to set it up.');
		return;
	}
	agent = await login();
	await sync(agent, siteMetadata);
}

main().catch(function (error) {
	console.error('[standard.site] ' + (error.message || error));
	process.exit(1);
});
