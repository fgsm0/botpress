import axios from 'axios'
import * as sdk from 'botpress/sdk'
import { SortOrder } from 'botpress/sdk'
import { BPRequest } from 'common/http'
import { Workspace } from 'common/typings'
import Knex from 'knex'
import _ from 'lodash'
import ms from 'ms'

import { COMMENT_TABLE_NAME, HANDOFF_TABLE_NAME, MODULE_NAME } from '../constants'

import { IAgent, IComment, IEvent, IHandoff } from './../types'
import { makeAgentId } from './helpers'

const debug = DEBUG(MODULE_NAME)

export interface CollectionConditions extends Partial<SortOrder> {
  limit?: number
}

const commentPrefix = 'comment'
const handoffPrefix = 'handoff'
const userPrefix = 'user'

const handoffColumns = [
  'id',
  'botId',
  'agentId',
  'userId',
  'userThreadId',
  'userChannel',
  'agentThreadId',
  'status',
  'tags',
  'assignedAt',
  'resolvedAt',
  'createdAt',
  'updatedAt'
]

const commentColumns = ['id', 'agentId', 'handoffId', 'threadId', 'content', 'createdAt', 'updatedAt']

const eventColumns = ['id', 'direction', 'botId', 'channel', 'success', 'createdOn', 'threadId', 'type', 'event']

const userColumns = ['id', 'attributes']

const commentColumnsPrefixed = commentColumns.map(s => commentPrefix.concat(':', s))

const userColumnsPrefixed = userColumns.map(s => userPrefix.concat(':', s))

export default class Repository {
  /**
   *
   * @param bp
   * @param timeouts Object to store agent session timeouts
   */
  constructor(private bp: typeof sdk, private timeouts: object) {}

  private serializeDate(object: object, paths: string[]) {
    const result = _.clone(object)

    paths.map(path => {
      _.has(object, path) && _.set(result, path, this.bp.database.date.format(_.get(object, path)))
    })

    return result
  }

  private serializeJson(object: object, paths: string[]) {
    const result = _.clone(object)

    paths.map(path => {
      _.has(object, path) && _.set(result, path, this.bp.database.json.set(_.get(object, path)))
    })

    return result
  }

  private applyLimit(query: Knex.QueryBuilder, conditions?: CollectionConditions) {
    if (conditions.limit) {
      return query.limit(_.toNumber(conditions.limit))
    } else {
      return query
    }
  }

  private applyOrderBy(query: Knex.QueryBuilder, conditions?: CollectionConditions) {
    if (_.has(conditions, 'column') && _.has(conditions, 'desc')) {
      return query.orderBy(conditions.column, conditions.desc ? 'desc' : 'asc')
    } else if (_.has(conditions, 'column')) {
      return query.orderBy(conditions.column)
    } else {
      return query
    }
  }

  private applyQuery = <T>(query?: Knex.QueryCallback) => {
    return (builder: Knex.QueryBuilder<T>) => {
      return query ? builder.modify(query) : builder
    }
  }

  // This mutates rows
  private hydrateHandoffs(rows: IHandoff[]) {
    const records = _.reduce(
      rows,
      (memo, row) => {
        memo[row.id] = memo[row.id] || {
          ..._.pick(row, handoffColumns),
          comments: {}
        }

        if (row['tags']) {
          memo[row.id].tags = this.bp.database.json.get(row.tags)
        }

        if (row[`${commentPrefix}:id`]) {
          const record = _.mapKeys(_.pick(row, commentColumnsPrefixed), (v, k) => _.split(k, ':').pop())
          memo[row.id].comments[row[`${commentPrefix}:id`]] = record
        }

        if (row[`${userPrefix}:id`]) {
          const record = _.mapKeys(_.pick(row, userColumnsPrefixed), (v, k) => _.split(k, ':').pop())
          record.attributes = this.bp.database.json.get(record.attributes)

          memo[row.id].user = record
        }

        return memo
      },
      {}
    )

    return _.values(records).map((record: IHandoff) => ({
      ...record,
      comments: _.values(record.comments)
    }))
  }

  // This mutates handoffs
  private hydrateEvents(events: IEvent[], handoffs: IHandoff[], key: string) {
    handoffs.forEach(handoff => (handoff[key] = {}))

    const toMerge = events.map(event => {
      return _.tap({}, item => {
        const record = _.pick(event, eventColumns)
        record.event = this.bp.database.json.get(record.event)

        item['id'] = event[`${handoffPrefix}:id`]
        item[key] = record
      })
    })

    return _.values(_.merge(_.keyBy(handoffs, 'id'), _.keyBy(toMerge, 'id')))
  }

  // To get the most recent event, we assume the 'Id' column is ordered;
  // thus meaning the highest Id is also the most recent.
  //
  // - Note: We're interested in 'incoming' & 'text' events only
  private recentEventQuery() {
    return this.bp
      .database<sdk.IO.StoredEvent>('events')
      .select('*')
      .andWhere(function() {
        this.whereIn('id', function() {
          this.max('id')
            .from('events')
            .where('type', 'text')
            .andWhere('direction', 'incoming')
            .groupBy('threadId')
        })
      })
      .as('recent_event')
  }

  private userEventsQuery(): Knex.QueryBuilder {
    return this.bp
      .database<IHandoff>(HANDOFF_TABLE_NAME)
      .select(
        `${HANDOFF_TABLE_NAME}.id as ${handoffPrefix}:id`,
        `${HANDOFF_TABLE_NAME}.userThreadId as ${handoffPrefix}:userThreadId`,
        'recent_event.*'
      )
      .join(this.recentEventQuery(), `${HANDOFF_TABLE_NAME}.userThreadId`, 'recent_event.threadId')
  }

  private handoffsWithAssociationsQuery(botId: string, conditions: CollectionConditions = {}) {
    return this.bp
      .database<IHandoff>(HANDOFF_TABLE_NAME)
      .select(
        `${HANDOFF_TABLE_NAME}.*`,
        `${COMMENT_TABLE_NAME}.id as ${commentPrefix}:id`,
        `${COMMENT_TABLE_NAME}.agentId as ${commentPrefix}:agentId`,
        `${COMMENT_TABLE_NAME}.handoffId as ${commentPrefix}:handoffId`,
        `${COMMENT_TABLE_NAME}.threadId as ${commentPrefix}:threadId`,
        `${COMMENT_TABLE_NAME}.content as ${commentPrefix}:content`,
        `${COMMENT_TABLE_NAME}.updatedAt as ${commentPrefix}:updatedAt`,
        `${COMMENT_TABLE_NAME}.createdAt as ${commentPrefix}:createdAt`,
        `srv_channel_users.user_id as ${userPrefix}:id`,
        `srv_channel_users.attributes as ${userPrefix}:attributes`
      )
      .leftJoin(COMMENT_TABLE_NAME, `${HANDOFF_TABLE_NAME}.userThreadId`, `${COMMENT_TABLE_NAME}.threadId`)
      .leftJoin('srv_channel_users', `${HANDOFF_TABLE_NAME}.userId`, 'srv_channel_users.user_id')
      .where(`${HANDOFF_TABLE_NAME}.botId`, botId)
      .modify(this.applyLimit, conditions)
      .modify(this.applyOrderBy, conditions)
      .orderBy([{ column: `${COMMENT_TABLE_NAME}.createdAt`, order: 'asc' }])
  }

  // hitlnext:online:workspaceId:agentId
  private agentSessionCacheKey = async (botId: string, agentId: string) => {
    return [MODULE_NAME, 'online', await this.bp.workspaces.getBotWorkspaceId(botId), agentId].join(':')
  }

  // Cache key that scopes agent status on a per-workspace basis.
  // It could also be scoped on a per-bot basis.
  // workspaceId:agentId
  private agentTimeoutCacheKey = (workspaceId: string, agentId: string) => {
    return [workspaceId, agentId].join('.')
  }

  private registerTimeout = async (
    workspaceId: string,
    botId: string,
    agentId: string,
    callback: (...args: any[]) => void
  ) => {
    const key = this.agentTimeoutCacheKey(workspaceId, agentId)
    const { agentSessionTimeout } = await this.bp.config.getModuleConfigForBot(MODULE_NAME, botId)

    // Clears previously registered timeout to avoid old timers to execute
    await this.unregisterTimeout(workspaceId, agentId)

    // Set a new timeout
    this.timeouts[key] = setTimeout(callback, ms(agentSessionTimeout as string))
  }

  private unregisterTimeout = async (workspaceId: string, agentId: string) => {
    const key = this.agentTimeoutCacheKey(workspaceId, agentId)

    if (this.timeouts[key]) {
      clearTimeout(this.timeouts[key])
    }
  }

  getAgentOnline = async (botId: string, agentId: string): Promise<boolean> => {
    const value = await this.bp.kvs.forBot(botId).get(await this.agentSessionCacheKey(botId, agentId))
    return !!value
  }

  /**
   *
   * @param botId
   * @param agentId
   * @param callback The function called when the agent's session expires
   */
  setAgentOnline = async (botId: string, agentId: string, callback: (...args: any[]) => void): Promise<boolean> => {
    const config = await this.bp.config.getModuleConfigForBot(MODULE_NAME, botId)

    await this.bp.kvs
      .forBot(botId)
      .set(await this.agentSessionCacheKey(botId, agentId), true, null, config.agentSessionTimeout)
      .then(async () => {
        const workspace = await this.bp.workspaces.getBotWorkspaceId(botId)

        await this.registerTimeout(workspace, botId, agentId, callback).then(() => {
          debug.forBot(botId, 'Registering timeout', { agentId })
        })
      })

    return true
  }

  unsetAgentOnline = async (botId: string, agentId: string) => {
    const config = await this.bp.config.getModuleConfigForBot(MODULE_NAME, botId)

    await this.bp.kvs
      .forBot(botId)
      .set(await this.agentSessionCacheKey(botId, agentId), false, null, config.agentSessionTimeout)
      .then(async () => {
        const workspace = await this.bp.workspaces.getBotWorkspaceId(botId)

        await this.unregisterTimeout(workspace, agentId)
      })

    return false
  }

  // This returns an agent with the following additional properties:
  // - isSuperAdmin
  // - permissions
  // - strategyType
  getCurrentAgent = async (req: BPRequest, botId: string, agentId: string): Promise<IAgent> => {
    const { data } = await axios.get('/auth/me/profile', {
      baseURL: `${process.LOCAL_URL}/api/v1`,
      headers: {
        Authorization: req.headers.authorization,
        'X-BP-Workspace': req.workspace
      }
    })

    return {
      ...data.payload,
      agentId,
      online: await this.getAgentOnline(botId, agentId)
    } as IAgent
  }

  /**
   * List all agents across workspaces and bots
   */
  listAllAgents = async () => {
    // TODO move this in workspace service
    const list = () => {
      return this.bp.ghost.forGlobal().readFileAsObject<Workspace[]>('/', 'workspaces.json')
    }

    return Promise.map(list(), workspace => {
      return this.listAgents(workspace.id)
    }).then(collection =>
      _(collection)
        .flatten()
        .uniqBy('agentId')
        .value()
    )
  }

  /**
   * List all agents for a given bot and workspace
   */
  listAgents = async (workspace: string): Promise<Omit<IAgent, 'online'>[]> => {
    const options: sdk.GetWorkspaceUsersOptions = {
      includeSuperAdmins: true,
      attributes: ['firstname', 'lastname', 'picture_url', 'created_at', 'updated_at']
    }

    // TODO filter out properly this is a quick fix
    const users = (await this.bp.workspaces.getWorkspaceUsers(workspace, options)).filter(
      u => u.role === 'admin' || u.role === 'agent'
    )
    // @ts-ignore
    return Promise.map(users, async user => {
      const agentId = makeAgentId(user.strategy, user.email)
      return {
        ...user,
        agentId
      }
    })
  }

  listHandoffs(
    botId: string,
    conditions: CollectionConditions = {},
    query?: Knex.QueryCallback,
    trx?: Knex.Transaction
  ) {
    const execute = async (trx: Knex.Transaction) => {
      const data = await this.handoffsWithAssociationsQuery(botId, conditions)
        .modify(this.applyQuery(query))
        .transacting(trx)
        .then(this.hydrateHandoffs.bind(this))

      const hydrated = this.hydrateEvents(
        await this.userEventsQuery()
          .where(`${HANDOFF_TABLE_NAME}.botId`, botId)
          .transacting(trx),
        data,
        'userConversation'
      )

      return hydrated
    }

    // Either join an existing transaction or start one
    if (trx) {
      return execute(trx)
    } else {
      return this.bp.database.transaction(trx => execute(trx))
    }
  }

  // Note:
  // - this is meant to find handoffs across bots
  // - 'active' means having a 'status' of either 'pending' or 'assigned'
  listActiveHandoffs = () => {
    return this.bp
      .database<IHandoff>(HANDOFF_TABLE_NAME)
      .where('status', 'pending')
      .orWhere('status', 'assigned')
  }

  // Note:
  // - 'active' means having a 'status' of either 'pending' or 'assigned'
  existingActiveHandoff = (botId: string, userId: string, userThreadId: string, userChannel: string) => {
    return this.bp
      .database<IHandoff>(HANDOFF_TABLE_NAME)
      .where('botId', botId)
      .andWhere('userId', userId)
      .andWhere('userThreadId', userThreadId)
      .andWhere('userChannel', userChannel)
      .andWhere(function() {
        this.where('status', 'assigned').orWhere('status', 'pending')
      })
      .then(data => !_.isEmpty(data))
  }

  /**
   * Finds a handoff *with* it's associations
   */
  async findHandoff(botId: string, id: string, trx?: Knex.Transaction) {
    const execute = async (trx: Knex.Transaction) => {
      const data = await this.handoffsWithAssociationsQuery(botId)
        .andWhere(`${HANDOFF_TABLE_NAME}.id`, id)
        .transacting(trx)
        .then(this.hydrateHandoffs.bind(this))

      const hydrated = this.hydrateEvents(
        await this.userEventsQuery()
          .where(`${HANDOFF_TABLE_NAME}.botId`, botId)
          .andWhere(`${HANDOFF_TABLE_NAME}.id`, id)
          .transacting(trx),
        data,
        'userConversation'
      )

      return _.head(hydrated)
    }

    // Either join an existing transaction or start one
    if (trx) {
      return execute(trx)
    } else {
      return this.bp.database.transaction(trx => execute(trx))
    }
  }

  /**
   * Finds a handoff *without* it's associations
   */
  getHandoff = (id: string) => {
    return this.bp
      .database<IHandoff>(HANDOFF_TABLE_NAME)
      .select('*')
      .where({ id })
      .limit(1)
      .then(this.hydrateHandoffs.bind(this))
      .then(data => _.head(data))
  }

  createHandoff = async (botId: string, attributes: Partial<IHandoff>) => {
    const now = new Date()
    const payload = this.serializeDate(
      {
        ...attributes,
        botId,
        createdAt: now,
        updatedAt: now
      },
      ['assignedAt', 'resolvedAt', 'createdAt', 'updatedAt']
    )

    return this.bp.database.transaction(async trx => {
      const id = await this.bp.database.insertAndRetrieve<string>(HANDOFF_TABLE_NAME, payload, 'id', 'id', trx)
      return this.findHandoff(botId, id, trx)
    })
  }

  updateHandoff = async (botId: string, id: string, attributes: Partial<IHandoff>) => {
    const now = new Date()
    const payload = _.flow(
      attrs => this.serializeDate(attrs, ['assignedAt', 'resolvedAt', 'updatedAt']),
      attrs => this.serializeJson(attrs, ['tags'])
    )({
      ...attributes,
      updatedAt: now
    })

    return this.bp.database.transaction(async trx => {
      await trx<IHandoff>(HANDOFF_TABLE_NAME)
        .where({ id })
        .update(payload)
      return this.findHandoff(botId, id, trx)
    })
  }

  createComment = (attributes: Partial<IComment>) => {
    const now = new Date()
    const payload = this.serializeDate(
      {
        ...attributes,
        updatedAt: now,
        createdAt: now
      },
      ['updatedAt', 'createdAt']
    )

    return this.bp.database.insertAndRetrieve<IComment>(COMMENT_TABLE_NAME, payload, commentColumns)
  }

  listMessages = (botId: string, threadId: string, conditions: CollectionConditions = {}) => {
    return this.bp.events.findEvents(
      { botId, threadId },
      { count: conditions.limit, sortOrder: [{ column: 'id', desc: true }] }
    )
  }
}
