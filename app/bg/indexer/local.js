import { PermissionsError } from 'beaker-error-constants'
import { normalizeOrigin, normalizeUrl } from '../../lib/urls'
import { joinPath, parseSimplePathSpec, toNiceUrl } from '../../lib/strings'
import {
  toArray,
  checkShouldExcludePrivate
} from './util'
import { METADATA_KEYS } from './const'

/**
 * @typedef {import('./const').Site} Site
 * @typedef {import('./const').SiteDescription} SiteDescription
 * @typedef {import('./const').RecordUpdate} RecordUpdate
 * @typedef {import('./const').ParsedUrl} ParsedUrl
 * @typedef {import('./const').RecordDescription} RecordDescription
 * @typedef {import('../filesystem/query').FSQueryResult} FSQueryResult
 * @typedef {import('./const').NotificationQuery} NotificationQuery
 * @typedef {import('../../lib/session-permissions').EnumeratedSessionPerm} EnumeratedSessionPerm
 */


// exported apis
// =

/**
 * @param {Object} db
 * @param {Object} [opts]
 * @param {String} [opts.search]
 * @param {String|String[]} [opts.index] - 'local', 'network', url of a specific hyperbee index
 * @param {Boolean} [opts.writable]
 * @param {Number} [opts.offset]
 * @param {Number} [opts.limit]
 * @returns {Promise<SiteDescription[]>}
 */
export async function listSites (db, opts) {
  var query = db('sites')
    .select('*')
    .offset(opts?.offset || 0)
  if (typeof opts?.limit === 'number') {
    query = query.limit(opts.limit)
  }
  if (opts?.search) {
    query = query.whereRaw(
      `sites.title LIKE ? OR sites.description LIKE ?`,
      [`%${opts.search}%`, `%${opts.search}%`]
    )
  }
  if (typeof opts?.writable === 'boolean') {
    query = query.where('sites.writable', opts.writable ? 1 : 0)
  }
  var siteRows = await query
  return siteRows.map(row => ({
    origin: row.origin,
    url: row.origin,
    title: row.title || toNiceUrl(row.origin),
    description: row.description,
    writable: Boolean(row.writable),
    index: {id: 'local'},
    graph: undefined
  }))
}

/**
 * @param {Object} db
 * @param {Object} opts
 * @param {String|String[]} [opts.origin]
 * @param {String|String[]} [opts.path]
 * @param {String} [opts.links]
 * @param {Boolean|NotificationQuery} [opts.notification]
 * @param {String|String[]} [opts.index] - 'local' or 'network'
 * @param {String} [opts.sort]
 * @param {Number} [opts.offset]
 * @param {Number} [opts.limit]
 * @param {Boolean} [opts.reverse]
 * @param {Object} [internal]
 * @param {Object} [internal.permissions]
 * @param {Number} [internal.notificationRtime]
 * @param {EnumeratedSessionPerm[]} [internal.permissions.query]
 * @returns {Promise<{records: RecordDescription[], missedOrigins: String[]}>}
 */
export async function query (db, opts, {permissions, notificationRtime} = {}) {
  var shouldExcludePrivate = checkShouldExcludePrivate(opts, permissions)

  var sep = `[>${Math.random()}<]`
  var query = db('sites')
    .innerJoin('records', 'sites.rowid', 'records.site_rowid')
    .leftJoin('records_data', function() {
      this.on('records.rowid', '=', 'records_data.record_rowid').onNotNull('records_data.value')
    })
    .select(
      'origin',
      'path',
      'prefix',
      'extension',
      'ctime',
      'mtime',
      'rtime',
      'title as siteTitle',
      db.raw(`group_concat(records_data.key, '${sep}') as data_keys`),
      db.raw(`group_concat(records_data.value, '${sep}') as data_values`)
    )
    .where({is_indexed: 1})
    .groupBy('records.rowid')
    .offset(opts.offset)
    .orderBy(opts.sort, opts.reverse ? 'desc' : 'asc')
  if (typeof opts.limit === 'number') {
    query = query.limit(opts.limit)
  }

  if (opts.sort === 'crtime') {
    query = query.select(db.raw(`CASE rtime WHEN rtime < ctime THEN rtime ELSE ctime END AS crtime`))
  } else if (opts.sort === 'mrtime') {
    query = query.select(db.raw(`CASE rtime WHEN rtime < mtime THEN rtime ELSE mtime END AS mrtime`))
  }

  if (opts?.origin) {
    if (Array.isArray(opts.origin)) {
      let origins = opts.origin = opts.origin.map(origin => normalizeOrigin(origin))
      if (shouldExcludePrivate && origins.find(origin => origin === 'hyper://private')) {
        throw new PermissionsError()
      }
      query = query.whereIn('origin', origins)
    } else {
      let origin = opts.origin = normalizeOrigin(opts.origin)
      if (shouldExcludePrivate && origin === 'hyper://private') {
        throw new PermissionsError()
      }
      query = query.where({origin})
    }
  } else {
    if (shouldExcludePrivate) {
      query = query.whereNot({origin: 'hyper://private'})
    }
    query = query.whereRaw(`sites.is_index_target = ?`, [1])
  }
  if (opts?.path) {
    if (Array.isArray(opts.path)) {
      query = query.where(function () {
        let chain = this.where(parseSimplePathSpec(opts.path[0]))
        for (let i = 1; i < opts.path.length; i++) {
          chain = chain.orWhere(parseSimplePathSpec(opts.path[i]))
        }
      })
    } else {
      query = query.where(parseSimplePathSpec(opts.path))
    }
  }
  if (typeof opts?.links === 'string') {
    query = query.joinRaw(
      `INNER JOIN records_data as link ON link.record_rowid = records.rowid AND link.value = ?`,
      [normalizeUrl(opts.links)]
    )
  }
  if (opts?.notification) {
    query = query
      .select(
        'notification_key',
        'notification_subject_origin',
        'notification_subject_path',
      )
      .innerJoin('records_notification', 'records.rowid', 'records_notification.record_rowid')
    if (opts.notification.unread) {
      query = query.whereRaw(`rtime > ?`, [notificationRtime])
    }
  }

  var sitesQuery
  if (opts?.origin && !opts?.links && !opts?.notification) {
    // fetch info on whether each given site has been indexed
    sitesQuery = db('sites').select('origin').where({is_indexed: 1})
    if (Array.isArray(opts.origin)) {
      sitesQuery = sitesQuery.whereIn('origin', opts.origin.map(origin => normalizeOrigin(origin)))
    } else {
      sitesQuery = sitesQuery.where({origin: normalizeOrigin(opts.origin)})
    }
  }

  var [rows, siteStates] = await Promise.all([
    query,
    sitesQuery
  ])

  var records = rows.map(row => {
    var record = {
      type: 'file',
      path: row.path,
      url: row.origin + row.path,
      ctime: row.ctime,
      mtime: row.mtime,
      metadata: {},
      index: {
        id: 'local',
        rtime: row.rtime,
        links: [],
      },
      content: undefined,
      site: {
        url: row.origin,
        title: row.siteTitle || toNiceUrl(row.origin)
      },
      notification: undefined
    }
    var dataKeys = (row.data_keys || '').split(sep)
    var dataValues = (row.data_values || '').split(sep)
    for (let i = 0; i < dataKeys.length; i++) {
      let key = dataKeys[i]
      if (key === METADATA_KEYS.content) {
        record.content = dataValues[i]
      } else if (key === METADATA_KEYS.link) {
        record.index.links.push(dataValues[i])
      } else {
        record.metadata[key] = dataValues[i]
      }
    }
    if (opts?.notification) {
      record.notification = {
        key: row.notification_key,
        subject: joinPath(row.notification_subject_origin, row.notification_subject_path),
        unread: row.rtime > notificationRtime
      }
    }
    return record
  })

  var missedOrigins
  if (siteStates) {
    // siteStates is a list of sites that are indexed
    // set-diff the desired origins against it
    missedOrigins = []
    for (let origin of toArray(opts.origin)) {
      if (!siteStates.find(state => state.origin === origin)) {
        missedOrigins.push(origin)
      }
    }
  }
  return {records, missedOrigins}
}

/**
 * @param {Object} db
 * @param {Object} [opts]
 * @param {String|Array<String>} [opts.origin]
 * @param {String|Array<String>} [opts.path]
 * @param {String} [opts.links]
 * @param {Boolean|NotificationQuery} [opts.notification]
 * @param {Object} [internal]
 * @param {Object} [internal.permissions]
 * @param {Number} [internal.notificationRtime]
 * @param {EnumeratedSessionPerm[]} [permissions.query]
 * @returns {Promise<{count: Number, includedOrigins: String[], missedOrigins: String[]}>}
 */
export async function count (db, opts, {permissions, notificationRtime} = {}) {
  var shouldExcludePrivate = checkShouldExcludePrivate(opts, permissions)

  var query = db('records')
    .innerJoin('sites', 'sites.rowid', 'records.site_rowid')
    .select(
      'origin',
      db.raw(`count(records.rowid) as count`)
    )
    .where({'sites.is_indexed': 1})
    .groupBy('origin')

  if (opts?.origin) {
    if (Array.isArray(opts.origin)) {
      let origins = opts.origin = opts.origin.map(origin => normalizeOrigin(origin))
      if (shouldExcludePrivate && origins.find(origin => origin === 'hyper://private')) {
        throw new PermissionsError()
      }
      query = query.whereIn('origin', origins)
    } else {
      let origin = opts.origin = normalizeOrigin(opts.origin)
      if (shouldExcludePrivate && origin === 'hyper://private') {
        throw new PermissionsError()
      }
      query = query.where({origin})
    }
  } else {
    if (shouldExcludePrivate) {
      query = query.whereNot({origin: 'hyper://private'})
    }
    query = query.whereRaw(`sites.is_index_target = ?`, [1])
  }
  if (opts?.path) {
    if (Array.isArray(opts.path)) {
      query = query.where(function () {
        let chain = this.where(parseSimplePathSpec(opts.path[0]))
        for (let i = 1; i < opts.path.length; i++) {
          chain = chain.orWhere(parseSimplePathSpec(opts.path[i]))
        }
      })
    } else {
      query = query.where(parseSimplePathSpec(opts.path))
    }
  }
  if (typeof opts?.links === 'string') {
    query = query.joinRaw(
      `INNER JOIN records_data as link ON link.record_rowid = records.rowid AND link.value = ?`,
      [normalizeUrl(opts.links)]
    )
  }
  if (opts?.notification) {
    query = query
      .innerJoin('records_notification', 'records.rowid', 'records_notification.record_rowid')
    if (opts.notification?.unread) {
      query = query.whereRaw(`records.rtime > ?`, [notificationRtime])
    }
  }

  var sitesQuery
  if (opts?.origin && !opts?.links && !opts?.notification) {
    // fetch info on whether each given site has been indexed
    sitesQuery = db('sites').select('origin').where({is_indexed: 1})
    if (Array.isArray(opts.origin)) {
      sitesQuery = sitesQuery.whereIn('origin', opts.origin.map(origin => normalizeOrigin(origin)))
    } else {
      sitesQuery = sitesQuery.where({origin: normalizeOrigin(opts.origin)})
    }
  }

  var [rows, siteStates] = await Promise.all([
    query,
    sitesQuery
  ])

  var count = rows.reduce((acc, row) => acc + row.count, 0)
  var includedOrigins = rows.map(row => row.origin)
  
  var missedOrigins
  if (siteStates) {
    // siteStates is a list of sites that are indexed
    // set-diff the desired origins against it
    missedOrigins = []
    for (let origin of toArray(opts.origin)) {
      if (!siteStates.find(state => state.origin === origin)) {
        missedOrigins.push(origin)
      }
    }
  }

  return {count, includedOrigins, missedOrigins}
}