const pUrl = require('url')

const { config, proxy } = require('internal')

const needle = require('needle')
const cheerio = require('cheerio')
const ytdl = require('youtube-dl')

const defaults = {
	name: 'Crunchyroll',
	prefix: 'crunchyroll_',
	origin: '',
	endpoint: 'https://www.crunchyroll.com',
	icon: 'https://fontmeme.com/images/Crunchyrolllogo.png',
	categories: []
}

let endpoint = defaults.endpoint

const headers = {
	'accept': 'application/json, text/plain, */*',
	'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
	'referer': endpoint,
	'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.103 Safari/537.36',
}

function setEndpoint(str) {
	if (str) {
		let host = str
		if (host.endsWith('/index.php'))
			host = host.replace('/index.php', '/')
		if (!host.endsWith('/'))
			host += '/'
		endpoint = host
		const origin = endpoint.replace(pUrl.parse(endpoint).path, '')
		headers['origin'] = origin
		headers['referer'] = endpoint + '/'
	}
	return true
}

setEndpoint(defaults.endpoint)

function retrieveManifest() {
	function manifest() {
		return {
			id: 'org.' + defaults.name.toLowerCase().replace(/[^a-z]+/g,''),
			version: '1.0.0',
			name: defaults.name,
			description: 'Anime from Crunchyroll - Subcription recommended',
			resources: ['stream', 'meta', 'catalog'],
			types: ['series', 'anime'],
			idPrefixes: [defaults.prefix],
			icon: defaults.icon,
			catalogs: [
				{
					id: defaults.prefix + 'catalog',
					type: 'anime',
					name: defaults.name,
					extra: [{ name: 'skip' }, { name: 'search' }]
				}
			]
		}
	}

	return new Promise((resolve, reject) => {
		resolve(manifest())
	})
}

function toMeta(obj, tags) {
	const poster = obj.img.replace('_small.', '_full.')
	const meta = {
		id: defaults.prefix + btoa('/en-gb' + obj.link),
		name: obj.name,
		type: 'series',
		poster: poster,
		background: poster,
		posterShape: 'landscape'
	}
	if (tags && Array.isArray(tags) && tags.length)
		meta.genres = tags.map(el => { return el.text })
	return meta
}

function retrieveDb() {
	return new Promise((resolve, reject) => {
		needle.get(endpoint + 'ajax/?req=RpcApiSearch_GetSearchCandidates', { headers }, (err, resp, body) => {
			if (!err && body) {
				const lines = body.split(/\r?\n/)
				if ((lines || []).length > 1) {
					let db
					try {
						db = JSON.parse(lines[1]).data
					} catch(e) {}
					if (db && db.length)
						resolve(db)
					else
						reject(new Error(defaults.name + ' - Could not get search db'))
				} else
					reject(defaults.name + ' - Invalid response from search db')
			} else
				reject(defaults.name + ' - HTTP error when trying to get search db')
		})
	})
}

let searchDb = []

let episodes = {}

function findMeta(id) {
	let meta = {}
	searchDb.some(el => {
		if (id.endsWith(el.link)) {
			meta = toMeta(el)
			return true
		}
	})
	return meta
}

function atob(str) {
  return Buffer.from(str, 'base64').toString('binary')
}

function btoa(str) {
  return Buffer.from(str.toString(), 'binary').toString('base64')
}

async function retrieveRouter() {

	searchDb = await retrieveDb()

	const manifest = await retrieveManifest()

	const { addonBuilder, getInterface, getRouter } = require('stremio-addon-sdk')

	const builder = new addonBuilder(manifest)

	builder.defineCatalogHandler(args => {
		return new Promise((resolve, reject) => {
			const extra = args.extra || {}
			if (extra.search) {
				const results = []
				searchDb.forEach(el => {
					if (el.type == 'Series' && el.name.toLowerCase().includes(extra.search.toLowerCase()))
						results.push(toMeta(el))
				})
				resolve({ metas: results })
			} else {
				let skip = extra.skip || 0
				skip = (skip / 40) + 1
				needle.get(endpoint + 'en-gb/videos/anime/popular/ajax_page?pg=' + skip, { headers }, (err, resp, body) => {
					if (!err && body) {
						const $ = cheerio.load(body)
						const results = []

						$('li').each((ij, el) => {
							results.push({
								id: defaults.prefix + btoa($(el).find('a').attr('href').split('\\/').join('/')),
								name: $(el).find('a').attr('title'),
								type: 'series',
								poster: $(el).find('img').attr('src')
							})
						})

						resolve({ metas: results, cacheMaxAge: 86400 })
					} else {
						reject(defaults.name + ' - Could not get catalog')
					}
				})
			}
		})
	})

	builder.defineMetaHandler(args => {
		return new Promise((resolve, reject) => {
			const id = atob(args.id.replace(defaults.prefix, ''))
			const meta = findMeta(id)
			if (!episodes[id]) {
				const videoHeaders = JSON.parse(JSON.stringify(headers))
				videoHeaders.referer = endpoint + id.substr(1) + '/videos'
				needle.get(videoHeaders.referer, { headers: videoHeaders }, (err, resp, body) => {
					if (!err && body) {
						const $ = cheerio.load(body)
						const results = []
						let releasedTime = Date.now() - 86400000
						$('.hover-bubble.group-item').each((ij, el) => {
							const seasonTitle = $(el).parents('li').find('a').attr('title')
							if (!seasonTitle) return
							let isDub = false
							if (seasonTitle.toLowerCase().endsWith(' dub)'))
							   isDub = true
							const href = 'https://www.crunchyroll.com' + $(el).find('a').attr('href')
							const name = $(el).find('.short-desc').text().trim()
							const number = parseInt($(el).find('.series-title').text().trim().replace( /^\D+/g, ''))
							const poster = $(el).find('img').attr('data-thumbnailurl')
							results.push({ name, season: 1, number, poster, href, released: new Date(releasedTime).toISOString() })
							releasedTime -= 86400000
						})
						episodes[id] = results
						setTimeout(() => {
							delete episodes[id]
						}, 3600000) // 1 hour cache
						meta.videos = results
						resolve({ meta })
					} else
						reject(defaults.name + ' - Could not get meta')
				})
			} else {
				meta.videos = episodes[id]
				resolve({ meta })
			}
		})
	})

	builder.defineStreamHandler(args => {
		return new Promise((resolve, reject) => {
			const parts = args.id.replace(defaults.prefix, '').split(':')
			const episode = parts[2]
			const id = atob(parts[0])
			if (episodes[id]) {
				let epData
				episodes[id].some(el => {
					if (el.number == episode) {
						epData = el
						return true
					}
				})
				if (epData && epData.href) {
					const args = ['-j']
					if (config.email && config.password) {
						args.push('--username=' + config.email)
						args.push('--password=' + config.password)
					}
				    const video = ytdl(epData.href, args)

				    video.on('error', err => {
				        reject(err || new Error(defaults.name + ' - Youtube-dl Error: Could Not Parse'))
				    })

				    video.on('info', info => {
				        if (info.url || info.formats) {
			        		let streams
			                 if (info.formats) {
			                    streams = info.formats.map(el => {
			                        return {
			                          availability: 1,
			                          url: el.url,
			                          title: el.format_id ? el.format_id : el.height ? (el.height + 'p') : '360p',
			                          tag: [(el.ext || 'mp4')],
			                          isFree: 1,
			                          id: args.id
			                        }
			                      })
			                } else {
			                    var el = info
			                    streams = [{
			                      availability: 1,
			                      url: el.url,
			                      title: el.format_id && isNaN(el.format_id) ? el.format_id : el.height ? (el.height + 'p') : '360p',
			                      tag: [(el.ext || 'mp4')],
			                      isFree: 1,
			                      id: args.id
			                    }]
			                }
			                resolve({ streams })
				        } else
				            reject(new Error(defaults.name + ' - Youtube-dl Error: No URL in Response'))
				    })
				} else
					reject(defaults.name + ' - Missing link for episode')
			} else
				reject(defaults.name + ' - Episode cache expired')
		})
	})

	const addonInterface = getInterface(builder)

	return getRouter(addonInterface)

}

module.exports = retrieveRouter()
