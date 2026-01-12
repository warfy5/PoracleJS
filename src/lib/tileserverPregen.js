const axios = require('axios')

class TileserverPregen {
	constructor(config, log) {
		this.axios = axios
		this.log = log
		this.config = config

		// Normalize staticProviderURL to array format for failover support
		this.tileservers = this.normalizeTileserverConfig(config.geocoding.staticProviderURL)
		this.currentServerIndex = 0
	}

	normalizeTileserverConfig(urlConfig) {
		const defaultTimeout = this.config.tuning?.tileserverTimeout || 10000

		// Handle single string (backward compatibility)
		if (typeof urlConfig === 'string') {
			return [{ url: urlConfig, timeout: defaultTimeout }]
		}

		// Handle array
		if (Array.isArray(urlConfig)) {
			return urlConfig.map(item => {
				// Array of strings
				if (typeof item === 'string') {
					return { url: item, timeout: defaultTimeout }
				}
				// Array of objects (future enhancement)
				return {
					url: item.url,
					timeout: item.timeout || defaultTimeout
				}
			})
		}

		// Fallback for invalid config
		this.log.warn('Invalid staticProviderURL configuration, using empty fallback')
		return [{ url: '', timeout: defaultTimeout }]
	}

	async withFailover(logReference, operation, operationName) {
		const serverCount = this.tileservers.length
		let lastError = null

		// Try each server starting from current
		for (let attempt = 0; attempt < serverCount; attempt++) {
			const serverIndex = (this.currentServerIndex + attempt) % serverCount
			const server = this.tileservers[serverIndex]

			try {
				this.log.debug(`${logReference}: Trying tileserver ${server.url} for ${operationName} (attempt ${attempt + 1}/${serverCount})`)

				// Execute operation with current server
				const result = await operation(server)

				// Success! Update current server for next request (sticky behavior)
				if (serverIndex !== this.currentServerIndex) {
					this.log.info(`${logReference}: ${operationName} succeeded on failover server #${attempt + 1}: ${server.url}`)
					this.currentServerIndex = serverIndex
				}

				return result

			} catch (error) {
				lastError = error
				this.log.warn(`${logReference}: ${operationName} failed on ${server.url}: ${error.message || error}`)

				// If not last server, log failover attempt
				if (attempt < serverCount - 1) {
					this.log.info(`${logReference}: Failing over to next tileserver...`)
				}
			}
		}

		// All servers failed
		this.log.error(`${logReference}: ${operationName} failed on all ${serverCount} tileserver(s)`)
		return null
	}

	getConfigForTileType(maptype) {
		const tileTemplate = maptype
		const configTemplate = maptype === 'monster' ? 'pokemon' : maptype

		const tileServerOptions = {}
		Object.assign(tileServerOptions, {
			type: 'staticMap',
			includeStops: false,
			width: 500,
			height: 250,
			zoom: 15,
			pregenerate: true,
		}, this.config.geocoding.tileserverSettings ? this.config.geocoding.tileserverSettings.default : null)

		if (this.config.geocoding.staticMapType && this.config.geocoding.staticMapType[configTemplate]) {
			Object.assign(tileServerOptions, {
				type: this.config.geocoding.staticMapType[configTemplate].startsWith('*') ? this.config.geocoding.staticMapType[configTemplate].substring(1) : this.config.geocoding.staticMapType[configTemplate],
				pregenerate: !this.config.geocoding.staticMapType[configTemplate].startsWith('*'),
			})
		}

		if (this.config.geocoding.tileserverSettings && this.config.geocoding.tileserverSettings[tileTemplate]) {
			Object.assign(tileServerOptions, this.config.geocoding.tileserverSettings[tileTemplate])
		}

		return tileServerOptions
	}

	async getPregeneratedTileURL(logReference, type, data, staticMapType) {
		let mapType = 'staticmap'
		let templateType = ''
		if (staticMapType.toLowerCase() === 'multistaticmap') {
			mapType = 'multistaticmap'
			templateType = 'multi-'
		}

		return this.withFailover(logReference, async (server) => {
			const url = `${server.url}/${mapType}/poracle-${templateType}${type}?pregenerate=true&regeneratable=true`

			this.log.debug(`${logReference}: Pre-generating static map ${url}`)
			const hrstart = process.hrtime()

			// Setup timeout with cancel token
			const timeoutMs = server.timeout
			const source = this.axios.CancelToken.source()
			const timeout = setTimeout(() => {
				source.cancel(`Timeout waiting for response - ${timeoutMs}ms`)
			}, timeoutMs)

			try {
				// Make POST request to tileserver
				const result = await this.axios.post(url, data, { cancelToken: source.token })
				clearTimeout(timeout)

				// Validate response
				if (result.status !== 200) {
					throw new Error(`HTTP ${result.status}: ${result.data?.reason || 'Unknown error'}`)
				}

				if (typeof result.data !== 'string') {
					throw new Error('Tileserver did not return tile ID string')
				}

				if (result.data.includes('<')) {
					throw new Error(`Tileserver returned HTML error page`)
				}

				// Calculate timing
				const hrend = process.hrtime(hrstart)
				const hrendms = hrend[1] / 1000000

				// Build full tile URL
				const tileResult = result.data.startsWith('http')
					? result.data
					: new URL(`${mapType}/pregenerated/${result.data}`, server.url).toString()

				// Log with timing stats
				const logFn = this.config.logger?.timingStats ? this.log.verbose : this.log.debug
				logFn(`${logReference}: Tile generated ${tileResult} (${hrendms.toFixed(0)} ms)`)

				return tileResult

			} catch (error) {
				clearTimeout(timeout)

				// Re-throw for failover handler
				if (error.response) {
					throw new Error(`HTTP ${error.response.status}: ${error.response.data?.reason || error.response.statusText}`)
				}
				throw error
			}
		}, `getPregeneratedTileURL(${type})`)
	}

	async getTileURL(logReference, type, data, staticMapType) {
		let mapType = 'staticmap'
		let templateType = ''
		if (staticMapType.toLowerCase() === 'multistaticmap') {
			mapType = 'multistaticmap'
			templateType = 'multi-'
		}

		// getTileURL just generates URLs, doesn't make HTTP requests
		// Use current server (or first if current is invalid)
		const server = this.tileservers[this.currentServerIndex] || this.tileservers[0]

		const url = new URL(`${mapType}/poracle-${templateType}${type}`, server.url)
		Object.keys(data).forEach((item) => {
			url.searchParams.set(item, data[item])
		})

		this.log.debug(`${logReference}: Generated tile URL ${url}`)
		return url.toString()
	}

	// Inspiration from https://github.com/ccev/stscpy/blob/main/tileserver/staticmap.py#L138

	/**
	 * work out zoom and lat/lon for best tile
	 * @param shapes
	 */
	// eslint-disable-next-line class-methods-use-this
	autoposition(shapes, width, height, margin = 1.25, defaultZoom = 17.5) {
		width /= margin
		height /= margin

		function adjustLatitude(lat, distance) {
			const earth = 6378.137 // radius of the earth in kilometer
			const pi = Math.PI
			const m = (1 / ((2 * pi / 360) * earth)) / 1000 // 1 meter in degree

			return lat + (distance * m)
		}

		function adjustLongitude(lat, lon, distance) {
			const earth = 6378.137 // radius of the earth in kilometer
			const pi = Math.PI
			const { cos } = Math
			const m = (1 / ((2 * pi / 360) * earth)) / 1000 // 1 meter in degree

			return lon + (distance * m) / cos(lat * (pi / 180))
		}

		const objs = []
		if (shapes.circles) {
			shapes.circles.forEach((c) => {
				objs.push([adjustLatitude(c.latitude, -c.radiusM), c.longitude])
				objs.push([adjustLatitude(c.latitude, c.radiusM), c.longitude])

				objs.push([c.latitude, adjustLongitude(c.latitude, c.longitude, -c.radiusM)])
				objs.push([c.latitude, adjustLongitude(c.latitude, c.longitude, c.radiusM)])
			})
		}
		if (shapes.markers) {
			objs.push(...shapes.markers.map((x) => [x.latitude, x.longitude]))
		}
		if (shapes.polygons) {
			shapes.polygons.forEach((p) => {
				objs.push(...p.path)
			})
		}

		if (!objs.length) return

		const lats = objs.map(([lat]) => lat)
		const lons = objs.map(([, lon]) => lon)

		const minLat = Math.min(...lats)
		const maxLat = Math.max(...lats)
		const minLon = Math.min(...lons)
		const maxLon = Math.max(...lons)

		const latitude = minLat + ((maxLat - minLat) / 2.0)
		const longitude = minLon + ((maxLon - minLon) / 2.0)

		const ne = [maxLat, maxLon]
		const sw = [minLat, minLon]

		if (ne === sw) {
			return {
				zoom: defaultZoom,
				latitude: lats[0],
				longitude: lons[0],
			}
		}

		function latRad(lat) {
			const sin = Math.sin(lat * Math.PI / 180.0)
			const rad = Math.log((1.0 + sin) / (1.0 - sin)) / 2.0
			return Math.max(Math.min(rad, Math.PI), -Math.PI) / 2.0
		}

		function roundToTwo(num) {
			return +(`${Math.round(`${num}e+2`)}e-2`)
		}

		function zoom(px, fraction) {
			return roundToTwo(Math.log2(px / 256.0 / fraction))
		}

		const latFraction = (latRad(ne[0]) - latRad(sw[0])) / Math.PI
		let angle = ne[1] - sw[1]
		if (angle < 0.0) angle += 360.0
		const lonFraction = angle / 360.0
		return {
			zoom: Math.min(zoom(height, latFraction), zoom(width, lonFraction)),
			latitude,
			longitude,
		}
	}

	// eslint-disable-next-line class-methods-use-this
	limits(latCenter, lonCenter, width, height, zoom) {
		// copied from https://help.openstreetmap.org/questions/75611/transform-xy-pixel-values-into-lat-and-long
		const C = (256 / (2 * Math.PI)) * 2 ** zoom

		const xcenter = C * (lonCenter * Math.PI / 180.0 + Math.PI)
		const ycenter = C * (Math.PI - Math.log(Math.tan((Math.PI / 4) + latCenter * Math.PI / 360.0)))

		const points = []
		for (const point of [[0, 0], [width, height]]) {
			const xpoint = xcenter - (width / 2 - point[0])
			const ypoint = ycenter - (height / 2 - point[1])

			const M = (xpoint / C) - Math.PI
			const N = -(ypoint / C) + Math.PI

			const finLon = M * 180.0 / Math.PI
			const finLat = (Math.atan(Math.E ** N) - (Math.PI / 4)) * 2 * 180.0 / Math.PI
			points.push([finLat, finLon])
		}
		return points
	}
}

module.exports = TileserverPregen
