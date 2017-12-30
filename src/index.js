import checkVersion from 'botpress-version-manager'
import path from 'path'
import fs from 'fs'
import _ from 'lodash'
import crypto from 'crypto'

import axios from 'axios'

let config = null
let service = null

const getClient = () => {
  return axios.create({
    baseURL: 'https://api.api.ai/v1',
    timeout: process.env.BOTPRESS_HTTP_TIMEOUT || 5000,
    headers: {'Authorization': 'Bearer ' + config.accessToken}
  })
}

const setService = () => {
  service = (userId, text) => {
    return getClient().post('/query?v=20170101', {
      query: text,
      lang: config.lang,
      sessionId: userId
    })
  }
}

const contextAdd = userId => (name, lifespan = 1) => {
  return getClient().post('/contexts?v=20170101', [
    { name, lifespan }
  ], { params: {sessionId: userId } })
}

const contextRemove = userId => name => {
  return getClient().delete('/contexts/' + name, { params: { sessionId: userId } })
}

const incomingMiddleware = (event, next) => {
  let shortUserId = _.get(event, 'user.id') || ''
  if (shortUserId.length > 36) {
    shortUserId = crypto.createHash('md5').update(shortUserId).digest("hex")
  }

  if (["message", "postback", "text", "quick_reply"].includes(event.type)) {

    service(shortUserId, event.payload || event.text)
    .then(({data}) => {
      const {result} = data
      if (config.mode === 'fulfillment'
        && result.fulfillment
        && result.fulfillment.speech
        && result.fulfillment.speech.length > 0) {
        event.bp.middlewares.sendOutgoing({
          type: 'text',
          platform: event.platform,
          text: result.fulfillment.speech,
          raw: {
            to: event.user.id,
            message: result.fulfillment.speech,
            channelId: event.platform !== 'slack' ? null : event.channel.id,
            options: event.platform !== 'slack' ? null : {}
          }
        })
        return null // swallow the event, don't call next()
      } else {
        event.nlp = Object.assign(result, {
          context: {
            add: contextAdd(shortUserId),
            remove: contextRemove(shortUserId)
          }
        })
        next()
      }
    })
    .catch(error => {
      let err = _.get(error, 'response.data.status')
        || _.get(error, 'message')
        || error
        || 'Unknown error'

      if (err && err.code) {
        err = '[' + err.code + '] Type:' + err.errorType + ':', err.errorDetails
      }

      console.log(error.stack)

      event.bp.logger.warn('botpress-api.ai', 'API Error. Could not process incoming text: ' + err);
      next()
    })
  } else {
    event.nlp = {
      context: {
        add: contextAdd(shortUserId),
        remove: contextRemove(shortUserId)
      }
    }

    next()
  }
}

module.exports = {

  config: {
    accessToken: { type: 'string', env: 'APIAI_TOKEN' },
    lang: { type: 'string', default: 'en' },
    mode: { type: 'choice', validation: ['fulfillment', 'fulfillmentPlus', 'default'], default: 'default' },
    actionIncludeFilter: { type: 'string', default: '(^$|^input\.(unknown|welcome)$|^smalltalk\.)' }
  },

  init: async function(bp, configurator) {
    checkVersion(bp, __dirname)

    bp.middlewares.register({
      name: 'apiai.incoming',
      module: 'botpress-api.ai',
      type: 'incoming',
      handler: incomingMiddleware,
      order: 10,
      description: 'Process natural language in the form of text. Structured data with an action and parameters for that action is injected in the incoming message event.'
    })

    config = await configurator.loadAll()
    setService()
  },

  ready: async function(bp, configurator) {
    const router = bp.getRouter('botpress-apiai')

    router.get('/config', async (req, res) => {
      res.send(await configurator.loadAll())
    })

    router.post('/config', async (req, res) => {
      const { accessToken, lang, mode, actionIncludeFilter } = req.body
      await configurator.saveAll({ accessToken, lang, mode, actionIncludeFilter })
      config = await configurator.loadAll()
      setService()
      res.sendStatus(200)
    })
  }
}
