import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import mkdirp from 'mkdirp';
import * as electron from 'electron';
import {MAX_RESPONSES} from '../common/constants';
import * as db from '../common/database';
import * as models from './index';
import {compress, decompress} from '../common/misc';

export const name = 'Response';
export const type = 'Response';
export const prefix = 'res';
export const canDuplicate = false;

export function init () {
  return {
    statusCode: 0,
    statusMessage: '',
    contentType: '',
    url: '',
    bytesRead: 0,
    elapsedTime: 0,
    headers: [],
    cookies: [],
    timeline: [],
    bodyPath: '', // Actual bodies are stored on the filesystem
    error: '',
    requestVersionId: null,

    // Things from the request
    settingStoreCookies: null,
    settingSendCookies: null
  };
}

export function migrate (doc) {
  doc = migrateBody(doc);
  return doc;
}

export function getById (id) {
  return db.get(type, id);
}

export function all () {
  return db.all(type);
}

export async function removeForRequest (parentId) {
  await db.removeWhere(type, {parentId});
}

export function remove (request) {
  return db.remove(request);
}

export function findRecentForRequest (requestId, limit) {
  return db.findMostRecentlyModified(type, {parentId: requestId}, limit);
}

export async function getLatestForRequest (requestId) {
  const responses = await findRecentForRequest(requestId, 1);
  return responses[0] || null;
}

export async function create (patch = {}, bodyBuffer = null) {
  if (!patch.parentId) {
    throw new Error('New Response missing `parentId`');
  }

  const {parentId} = patch;

  // Create request version snapshot
  const request = await models.request.getById(parentId);
  const requestVersion = request ? await models.requestVersion.create(request) : null;
  patch.requestVersionId = requestVersion ? requestVersion._id : null;

  // Delete all other responses before creating the new one
  const allResponses = await db.findMostRecentlyModified(type, {parentId}, MAX_RESPONSES);
  const recentIds = allResponses.map(r => r._id);
  await db.removeWhere(type, {parentId, _id: {$nin: recentIds}});

  // Actually create the new response
  const bodyPath = bodyBuffer ? storeBodyBuffer(bodyBuffer) : '';
  return db.docCreate(type, {bodyPath}, patch);
}

export function getLatestByParentId (parentId) {
  return db.getMostRecentlyModified(type, {parentId});
}

export function getBodyBuffer (response, readFailureValue = null) {
  // No body, so return empty Buffer
  if (!response.bodyPath) {
    return new Buffer([]);
  }

  try {
    return decompress(fs.readFileSync(response.bodyPath));
  } catch (err) {
    console.warn('Failed to read response body', err.message);
    return readFailureValue;
  }
}

export function storeBodyBuffer (bodyBuffer) {
  const root = electron.remote.app.getPath('userData');
  const dir = path.join(root, 'responses');

  mkdirp.sync(dir);

  const hash = crypto.createHash('md5').update(bodyBuffer).digest('hex');

  const fullPath = path.join(dir, `${hash}.zip`);

  try {
    fs.writeFileSync(fullPath, compress(bodyBuffer));
  } catch (err) {
    console.warn('Failed to write response body to file', err.message);
  }

  return fullPath;
}

function migrateBody (doc) {
  if (doc.hasOwnProperty('body') && doc._id && !doc.bodyPath) {
    const bodyBuffer = Buffer.from(doc.body, doc.encoding || 'utf8');
    const bodyPath = storeBodyBuffer(bodyBuffer);
    const newDoc = Object.assign(doc, {bodyPath});
    db.docUpdate(newDoc);
    return newDoc;
  } else {
    return doc;
  }
}
