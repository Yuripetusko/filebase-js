/**
 * A client library for the https://filebase.storage/ service. It provides a convenient
 * interface for working with the [Raw HTTP API](https://filebase.storage/#api-docs)
 * from a web browser or [Node.js](https://nodejs.org/) and comes bundled with
 * TS for out-of-the box type inference and better IntelliSense.
 *
 * @example
 * ```js
 * import { FilebaseClient, File, Blob } from "filebase.storage"
 * const client = new FilebaseClient({ token: API_TOKEN })
 *
 * const cid = await client.storeBlob(new Blob(['hello world']))
 * ```
 * @module
 */

import { pack } from 'ipfs-car/pack'
import { CID } from 'multiformats/cid'
import * as Token from './token.js'
import { File, Blob, FormData, Blockstore } from './platform.js'
import { toGatewayURL } from './gateway.js'
import { BlockstoreCarReader } from './bs-car-reader.js'
import pipe from 'it-pipe'
import { Upload } from "@aws-sdk/lib-storage";
import { S3Client, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import stream from 'stream'

const MAX_STORE_RETRIES = 5
const MAX_CONCURRENT_UPLOADS = 4
const DEFAULT_ENDPOINT = 'https://s3.filebase.com'

/**
 * @typedef {import('./lib/interface.js').Service} Service
 * @typedef {import('./lib/interface.js').CIDString} CIDString
 * @typedef {import('./lib/interface.js').Deal} Deal
 * @typedef {import('./lib/interface.js').FileObject} FileObject
 * @typedef {import('./lib/interface.js').FilesSource} FilesSource
 * @typedef {import('./lib/interface.js').Pin} Pin
 * @typedef {import('./lib/interface.js').CarReader} CarReader
 * @typedef {import('./lib/interface.js').S3ClientConfig} S3ClientConfig
 * @typedef {import('ipfs-car/blockstore').Blockstore} BlockstoreI
 * @typedef {import('./lib/interface.js').RateLimiter} RateLimiter
 */

/**
 * @template {import('./lib/interface.js').TokenInput} T
 * @typedef {import('./lib/interface.js').Token<T>} TokenType
 */

/**
 * Parses Authentication Token
 *
 * @param {string | string[]} tokenToParse
 * @returns {import('./lib/interface.js').ParseTokenResult}
 */
function parseToken(tokenToParse) {
  if (Array.isArray(tokenToParse)) {
    if (typeof tokenToParse[2] === "undefined") {
      throw new Error(`No Bucket Found`);
    }
    return {
      credentials: tokenToParse,
      bucket: tokenToParse[2]
    }
  }

  const tokenBuffer = Buffer.from(tokenToParse, 'base64')
  const token = tokenBuffer.toString('ascii').split(':')
  const bucket = token[2]

  if (typeof token === "undefined" || !Array.isArray(token)) {
    throw new Error(`Token Not Found`)
  }

  if (typeof token[0] !== "string") {
    throw new Error(`Invalid Access Key`)
  }

  if (typeof token[1] !== "string") {
    throw new Error(`Invalid Secret Key`)
  }

  if (typeof bucket === "undefined") {
    throw new Error(`No Bucket Found`);
  }

  return {
    credentials: token,
    bucket: bucket
  }
}

/**
 */
class FilebaseClient {
  /**
   * Constructs a client bound to the given `options.token` and
   * `options.endpoint`.
   *
   * @example
   * ```js
   * import { FilebaseClient, File, Blob } from "filebase.storage"
   * const client = new FilebaseClient({ token: API_TOKEN })
   *
   * const cid = await client.storeBlob(new Blob(['hello world']))
   * ```
   * Optionally you could pass an alternative API endpoint (e.g. for testing)
   * @example
   * ```js
   * import { FilebaseClient } from "filebase.storage"
   * const client = new FilebaseClient({
   *   token: API_TOKEN
   *   endpoint: new URL('http://localhost:8080/')
   * })
   * ```
   *
   * @param {{token: string, endpoint?: string, s3config?: S3ClientConfig, bucket?: string}} options
   */
  constructor({
    endpoint = DEFAULT_ENDPOINT,
    token,
    s3config,
    bucket
  }) {
    this.endpoint = endpoint

    if (typeof token === "undefined" && s3config) {
      this.s3config = s3config
      if (typeof this.s3config.credentials === "undefined") {
        throw new Error(`Must pass credentials`)
      }
    } else {
      const parsedToken = parseToken(token)
      this.token = parsedToken.credentials
      this.bucket = bucket || parsedToken.bucket

      this.s3config = {
        credentials: {
          accessKeyId: this.token[0] || "",
          secretAccessKey: this.token[1] || ""
        },
        endpoint: endpoint,
        maxAttempts: MAX_STORE_RETRIES,
        region: "us-east-1",
        forcePathStyle: true,
      }
    }
  }

  /**
   * Stores a single file and returns its CID.
   *
   * @param {Service} service
   * @param {Blob} blob
   * @param {string | null} objectName
   * @returns {Promise<CIDString>}
   */
  static async storeBlob(service, blob, objectName = null) {
    const blockstore = new Blockstore()

    try {
      const { cid, car } = await FilebaseClient.encodeBlob(blob, { blockstore })
      const storedCid = await FilebaseClient.storeCar(service, car, objectName || cid.toString())

      return storedCid;
    } finally {
      await blockstore.close()
    }
  }

  /**
   * Stores a CAR file and returns its root CID.
   *
   * @param {Service} service
   * @param {AsyncIterable<Uint8Array>} car
   * @param {string} objectName
   * @param {import('./lib/interface.js').CarStorerOptions} [options]
   * @returns {Promise<CIDString>}
   */
  static async storeCar(
    { endpoint, token, s3config, bucket },
    car,
    objectName ,
    { onStoredChunk, onComplete, maxRetries} = {}
  ) {
    const selectedEndpoint = endpoint || DEFAULT_ENDPOINT;

    if (typeof s3config === "undefined" && typeof token !== "undefined") {
      const parsedToken = await parseToken(token)
      this.token = parsedToken.credentials
      this.bucket = bucket || parsedToken.bucket

      s3config = {
        credentials: {
          accessKeyId: this.token[0] || "",
          secretAccessKey: this.token[1] || ""
        },
        endpoint: selectedEndpoint,
        maxAttempts: maxRetries || MAX_STORE_RETRIES,
        region: "us-east-1",
        forcePathStyle: true,
      }
    } else {
      this.bucket = bucket
    }

    if (typeof s3config === "undefined") {
      throw new Error(`s3config not defined`)
    }

    const s3client = new S3Client(s3config);

    // Convert to an S3 upload of the full car
    const readableStream = stream.Readable.from(car)
    onComplete && readableStream.on('finish', onComplete)
    const parallelUploads3 = new Upload({
      client: s3client,
      params: {
        Bucket: this.bucket,
        Key: objectName,
        Body: readableStream,
        Metadata: {
          import: 'car'
        },
      },
      queueSize: MAX_CONCURRENT_UPLOADS,
      leavePartsOnError: false, // optional manually handle dropped parts
    });

    let storedBytes = 0.01
    let progressBytes = storedBytes
    parallelUploads3.on("httpUploadProgress", (progress) => {
      if (typeof progress.loaded !== "number") {
        throw new Error(`Expected Number for Loaded Progress`);
      }
      progressBytes = progress.loaded - storedBytes;
      storedBytes = progress.loaded;
      onStoredChunk && onStoredChunk(progressBytes)
    });

    await parallelUploads3.done();

    const headCommand = new HeadObjectCommand({
      Bucket: this.bucket,
      Key: objectName,
    })
    const carHeader = await s3client.send(headCommand);

    if (typeof carHeader.Metadata === "undefined" || typeof carHeader.Metadata['cid'] === "undefined") {
      throw new Error(`No CID Returned from Remote`)
    }

    return carHeader.Metadata['cid'];
  }

  /**
   * Stores a directory of files and returns a CID. Provided files **MUST**
   * be within the same directory, otherwise error is raised e.g. `foo/bar.png`,
   * `foo/bla/baz.json` is ok but `foo/bar.png`, `bla/baz.json` is not.
   *
   * @param {Service} service
   * @param {FilesSource} filesSource
   * @param {string | null} objectName
   * @returns {Promise<CIDString>}
   */
  static async storeDirectory(service, filesSource, objectName = null) {
    const blockstore = new Blockstore()
    let cidString
    try {
      const { cid, car } = await FilebaseClient.encodeDirectory(filesSource, {
        blockstore,
      })
      cidString = cid.toString()
      await FilebaseClient.storeCar(service, car, objectName || cid.toString())
    } finally {
      await blockstore.close()
    }

    return cidString
  }

  /**
   * Stores the given token and all resources it references (in the form of a
   * File or a Blob) along with a metadata JSON as specificed in ERC-1155. The
   * `token.image` must be either a `File` or a `Blob` instance, which will be
   * stored and the corresponding content address URL will be saved in the
   * metadata JSON file under `image` field.
   *
   * If `token.properties` contains properties with `File` or `Blob` values,
   * those also get stored and their URLs will be saved in the metadata JSON
   * file in their place.
   *
   * Note: URLs for `File` objects will retain file names e.g. in case of
   * `new File([bytes], 'cat.png', { type: 'image/png' })` will be transformed
   * into a URL that looks like `ipfs://bafy...hash/image/cat.png`. For `Blob`
   * objects, the URL will not have a file name name or mime type, instead it
   * will be transformed into a URL that looks like
   * `ipfs://bafy...hash/image/blob`.
   *
   * @template {import('./lib/interface.js').TokenInput} T
   * @param {Service} service
   * @param {T} metadata
   * @param {string | null} objectName
   * @returns {Promise<TokenType<T>>}
   */
  static async store(service, metadata, objectName = null) {
    const { token, car, cid } = await FilebaseClient.encodeNFT(metadata)
    await FilebaseClient.storeCar(service, car, objectName || cid.toString())
    return token
  }

  /**
   * Returns current status of the stored NFT by its CID. Note the NFT must
   * have previously been stored by this account.
   *
   * @param {Service} service
   * @param {string} cid
   * @param {string | null} objectName
   * @returns {Promise<import('./lib/interface.js').StatusResult>}
   */
  static async status(
    { endpoint, token, s3config, bucket },
    cid,
    objectName
  ) {
    const selectedEndpoint = endpoint || DEFAULT_ENDPOINT;

    if (typeof s3config === "undefined" && typeof token !== "undefined") {
      const parsedToken = parseToken(token)
      this.token = parsedToken.credentials
      this.bucket = bucket || parsedToken.bucket

      s3config = {
        credentials: {
          accessKeyId: this.token[0] || "",
          secretAccessKey: this.token[1] || ""
        },
        endpoint: selectedEndpoint,
        maxAttempts: MAX_STORE_RETRIES,
        region: "us-east-1",
        forcePathStyle: true,
      }
    } else {
      this.bucket = bucket
    }

    if (typeof s3config === "undefined") {
      throw new Error(`s3config not defined`)
    }

    const s3client = new S3Client(s3config);

    const headCommand = new HeadObjectCommand({
      Bucket: this.bucket,
      Key: objectName || cid,
    })
    const carHeader = await s3client.send(headCommand);

    if (typeof carHeader.Metadata === "undefined" || typeof carHeader.Metadata['cid'] === "undefined") {
      throw new Error(`No CID Returned from Remote`)
    }

    if (typeof carHeader['ContentLength'] !== "number") {
      throw new Error(`Invalid Content Length`)
    }

    const displayDate = carHeader.LastModified;

    if (typeof displayDate === "undefined") {
      throw new Error('Invalid Date')
    }

    return {
      cid: carHeader.Metadata['cid'],
      size: carHeader['ContentLength'],
      deals: [],
      pin: {
        cid: carHeader.Metadata['cid'],
        name: carHeader.Metadata['cid'],
        status: 'pinned',
        created: displayDate,
      },
      created: displayDate,
    }
  }


  /**
   * Removes stored content by its CID from this account. Please note that
   * even if content is removed from the service other nodes that have
   * replicated it might still continue providing it.
   *
   * @param {Service} service
   * @param {string} cid
   * @param {string | null} objectName
   * @returns {Promise<void>}
   */
  static async delete(
    { endpoint, token, s3config, bucket },
    cid,
    objectName = null
  ) {
    const selectedEndpoint = endpoint || DEFAULT_ENDPOINT

    if (typeof s3config === "undefined" && typeof token !== "undefined") {
      const parsedToken = parseToken(token)
      this.token = parsedToken.credentials
      this.bucket = bucket || parsedToken.bucket

      s3config = {
        credentials: {
          accessKeyId: this.token[0] || "",
          secretAccessKey: this.token[1] || ""
        },
        endpoint: selectedEndpoint,
        region: "us-east-1",
        forcePathStyle: true,
      }
    } else {
      this.bucket = bucket;
    }

    if (typeof s3config === "undefined") {
      throw new Error(`s3config not defined`)
    }

    const s3client = new S3Client(s3config);

    const deleteCommand = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: objectName || cid,
    })

    await s3client.send(deleteCommand);
  }

  /**
   * Encodes the given token and all resources it references (in the form of a
   * File or a Blob) along with a metadata JSON as specificed in ERC-1155 to a
   * CAR file. The `token.image` must be either a `File` or a `Blob` instance,
   * which will be stored and the corresponding content address URL will be
   * saved in the metadata JSON file under `image` field.
   *
   * If `token.properties` contains properties with `File` or `Blob` values,
   * those also get stored and their URLs will be saved in the metadata JSON
   * file in their place.
   *
   * Note: URLs for `File` objects will retain file names e.g. in case of
   * `new File([bytes], 'cat.png', { type: 'image/png' })` will be transformed
   * into a URL that looks like `ipfs://bafy...hash/image/cat.png`. For `Blob`
   * objects, the URL will not have a file name name or mime type, instead it
   * will be transformed into a URL that looks like
   * `ipfs://bafy...hash/image/blob`.
   *
   * @example
   * ```js
   * const { token, car } = await FilebaseClient.encodeNFT({
   *   name: 'filebase.storage store test',
   *   description: 'Test ERC-1155 compatible metadata.',
   *   image: new File(['<DATA>'], 'pinpie.jpg', { type: 'image/jpg' }),
   *   properties: {
   *     custom: 'Custom data can appear here, files are auto uploaded.',
   *     file: new File(['<DATA>'], 'README.md', { type: 'text/plain' }),
   *   }
   * })
   *
   * console.log('IPFS URL for the metadata:', token.url)
   * console.log('metadata.json contents:\n', token.data)
   * console.log('metadata.json with IPFS gateway URLs:\n', token.embed())
   *
   * // Now store the CAR file on filebase.storage
   * await client.storeCar(car)
   * ```
   *
   * @template {import('./lib/interface.js').TokenInput} T
   * @param {T} input
   * @returns {Promise<{ cid: CID, token: TokenType<T>, car: AsyncIterable<Uint8Array> }>}
   */
  static async encodeNFT(input) {
    validateERC1155(input)
    return Token.Token.encode(input)
  }

  /**
   * Encodes a single file to a CAR file and also returns its root CID.
   *
   * @example
   * ```js
   * const content = new Blob(['hello world'])
   * const { cid, car } = await FilebaseClient.encodeBlob(content)
   *
   * // Root CID of the file
   * console.log(cid.toString())
   *
   * // Now store the CAR file on filebase.storage
   * await client.storeCar(car)
   * ```
   *
   * @param {Blob} blob
   * @param {object} [options]
   * @param {BlockstoreI} [options.blockstore]
   * @returns {Promise<{ cid: CID, car: AsyncIterable<Uint8Array> }>}
   */
  static async encodeBlob(blob, { blockstore } = {}) {
    if (blob.size === 0) {
      throw new Error('Content size is 0, make sure to provide some content')
    }
    return packCar([toImportCandidate('blob', blob)], {
      blockstore,
      wrapWithDirectory: false,
    })
  }

  /**
   * Encodes a directory of files to a CAR file and also returns the root CID.
   * Provided files **MUST** be within the same directory, otherwise error is
   * raised e.g. `foo/bar.png`, `foo/bla/baz.json` is ok but `foo/bar.png`,
   * `bla/baz.json` is not.
   *
   * @example
   * ```js
   * const { cid, car } = await FilebaseClient.encodeDirectory([
   *   new File(['hello world'], 'hello.txt'),
   *   new File([JSON.stringify({'from': 'incognito'}, null, 2)], 'metadata.json')
   * ])
   *
   * // Root CID of the directory
   * console.log(cid.toString())
   *
   * // Now store the CAR file on filebase.storage
   * await client.storeCar(car)
   * ```
   *
   * @param {FilesSource} files
   * @param {object} [options]
   * @param {BlockstoreI} [options.blockstore]
   * @returns {Promise<{ cid: CID, car: AsyncIterable<Uint8Array> }>}
   */
  static async encodeDirectory(files, { blockstore } = {}) {
    let size = 0
    const input = pipe(files, async function* (files) {
      for await (const file of files) {
        yield toImportCandidate(file.name, file)
        size += file.size
      }
    })
    const packed = await packCar(input, {
      blockstore,
      wrapWithDirectory: true,
    })
    if (size === 0) {
      throw new Error(
        'Total size of files should exceed 0, make sure to provide some content'
      )
    }
    return packed
  }

  /**
   * Stores a single file and returns the corresponding Content Identifier (CID).
   * Takes a [Blob](https://developer.mozilla.org/en-US/docs/Web/API/Blob/Blob)
   * or a [File](https://developer.mozilla.org/en-US/docs/Web/API/File). Note
   * that no file name or file metadata is retained.
   *
   * @example
   * ```js
   * const content = new Blob(['hello world'])
   * const cid = await client.storeBlob(content)
   * cid //> 'zdj7Wn9FQAURCP6MbwcWuzi7u65kAsXCdjNTkhbJcoaXBusq9'
   * ```
   *
   * @param {Blob} blob
   * @param {string | null} objectName
   */
  storeBlob(blob, objectName = null) {
    return FilebaseClient.storeBlob(this, blob, objectName)
  }

  /**
   * Stores files encoded as a single [Content Addressed Archive
   * (CAR)](https://github.com/ipld/specs/blob/master/block-layer/content-addressable-archives.md).
   *
   * Takes a [Blob](https://developer.mozilla.org/en-US/docs/Web/API/Blob/Blob)
   * or a [File](https://developer.mozilla.org/en-US/docs/Web/API/File).
   *
   * Returns the corresponding Content Identifier (CID).
   *
   * See the [`ipfs-car` docs](https://www.npmjs.com/package/ipfs-car) for more
   * details on packing a CAR file.
   *
   * @example
   * ```js
   * import { pack } from 'ipfs-car/pack'
   * import { CarReader } from '@ipld/car'
   * const { out, root } = await pack({
   *  input: fs.createReadStream('pinpie.pdf')
   * })
   * const expectedCid = root.toString()
   * const carReader = await CarReader.fromIterable(out)
   * const cid = await storage.storeCar(carReader)
   * console.assert(cid === expectedCid)
   * ```
   *
   * @example
   * ```
   * import { packToBlob } from 'ipfs-car/pack/blob'
   * const data = 'Hello world'
   * const { root, car } = await packToBlob({ input: [new TextEncoder().encode(data)] })
   * const expectedCid = root.toString()
   * const cid = await client.storeCar(car)
   * console.assert(cid === expectedCid)
   * ```
   * @param {AsyncIterable<Uint8Array>} car
   * @param {string} objectName
   * @param {import('./lib/interface.js').CarStorerOptions} [options]
   */
  storeCar(car, objectName, options) {
    return FilebaseClient.storeCar(this, car, objectName, options)
  }

  /**
   * Stores a directory of files and returns a CID for the directory.
   *
   * @example
   * ```js
   * const cid = await client.storeDirectory([
   *   new File(['hello world'], 'hello.txt'),
   *   new File([JSON.stringify({'from': 'incognito'}, null, 2)], 'metadata.json')
   * ])
   * cid //>
   * ```
   *
   * Argument can be a [FileList](https://developer.mozilla.org/en-US/docs/Web/API/FileList)
   * instance as well, in which case directory structure will be retained.
   *
   * @param {FilesSource} files
   * @param {string | null} objectName
   */
  storeDirectory(files, objectName = null) {
    return FilebaseClient.storeDirectory(this, files, objectName)
  }

  /**
   * Returns current status of the stored NFT by its CID. Note the NFT must
   * have previously been stored by this account.
   *
   * @example
   * ```js
   * const status = await client.status('zdj7Wn9FQAURCP6MbwcWuzi7u65kAsXCdjNTkhbJcoaXBusq9')
   * ```
   *
   * @param {string} cid
   * @param {string | null} objectName
   */
  status(cid, objectName = null) {
    return FilebaseClient.status(this, cid, objectName)
  }

  /**
   * Removes stored content by its CID from the service.
   *
   * > Please note that even if content is removed from the service other nodes
   * that have replicated it might still continue providing it.
   *
   * @example
   * ```js
   * await client.delete('zdj7Wn9FQAURCP6MbwcWuzi7u65kAsXCdjNTkhbJcoaXBusq9')
   * ```
   *
   * @param {string} cid
   * @param {string | null} objectName
   */
  delete(cid, objectName = null) {
    return FilebaseClient.delete(this, cid, objectName)
  }

  /**
   * Stores the given token and all resources it references (in the form of a
   * File or a Blob) along with a metadata JSON as specificed in
   * [ERC-1155](https://eips.ethereum.org/EIPS/eip-1155#metadata). The
   * `token.image` must be either a `File` or a `Blob` instance, which will be
   * stored and the corresponding content address URL will be saved in the
   * metadata JSON file under `image` field.
   *
   * If `token.properties` contains properties with `File` or `Blob` values,
   * those also get stored and their URLs will be saved in the metadata JSON
   * file in their place.
   *
   * Note: URLs for `File` objects will retain file names e.g. in case of
   * `new File([bytes], 'cat.png', { type: 'image/png' })` will be transformed
   * into a URL that looks like `ipfs://bafy...hash/image/cat.png`. For `Blob`
   * objects, the URL will not have a file name name or mime type, instead it
   * will be transformed into a URL that looks like
   * `ipfs://bafy...hash/image/blob`.
   *
   * @example
   * ```js
   * const metadata = await client.store({
   *   name: 'filebase.storage store test',
   *   description: 'Test ERC-1155 compatible metadata.',
   *   image: new File(['<DATA>'], 'pinpie.jpg', { type: 'image/jpg' }),
   *   properties: {
   *     custom: 'Custom data can appear here, files are auto uploaded.',
   *     file: new File(['<DATA>'], 'README.md', { type: 'text/plain' }),
   *   }
   * })
   *
   * console.log('IPFS URL for the metadata:', metadata.url)
   * console.log('metadata.json contents:\n', metadata.data)
   * console.log('metadata.json with IPFS gateway URLs:\n', metadata.embed())
   * ```
   *
   * @template {import('./lib/interface.js').TokenInput} T
   * @param {T} token
   * @param {string | null} objectName
   */
  store(token, objectName = null) {
    return FilebaseClient.store(this, token, objectName)
  }
}

/**
 * Cast an iterable to an asyncIterable
 * @template T
 * @param {Iterable<T>} iterable
 * @returns {AsyncIterable<T>}
 */
export function toAsyncIterable(iterable) {
  return (async function* () {
    for (const item of iterable) {
      yield item
    }
  })()
}

/**
 * @template {import('./lib/interface.js').TokenInput} T
 * @param {T} metadata
 */
const validateERC1155 = ({ name, description, image, decimals }) => {
  // Just validate that expected fields are present
  if (typeof name !== 'string') {
    throw new TypeError(
      'string property `name` identifying the asset is required'
    )
  }
  if (typeof description !== 'string') {
    throw new TypeError(
      'string property `description` describing asset is required'
    )
  }
  if (!(image instanceof Blob)) {
    throw new TypeError('property `image` must be a Blob or File object')
  } else if (!image.type.startsWith('image/')) {
    console.warn(`According to ERC721 Metadata JSON Schema 'image' must have 'image/*' mime type.

For better interoperability we would highly recommend storing content with different mime type under 'properties' namespace e.g. \`properties: { video: file }\` and using 'image' field for storing a preview image for it instead.

For more context please see ERC-721 specification https://eips.ethereum.org/EIPS/eip-721`)
  }

  if (typeof decimals !== 'undefined' && typeof decimals !== 'number') {
    throw new TypeError('property `decimals` must be an integer value')
  }
}

/**
 * @param {import('ipfs-car/pack').ImportCandidateStream|Array<{ path: string, content: import('./platform.js').ReadableStream }>} input
 * @param {object} [options]
 * @param {BlockstoreI} [options.blockstore]
 * @param {boolean} [options.wrapWithDirectory]
 */
const packCar = async (input, { blockstore, wrapWithDirectory } = {}) => {
  /* c8 ignore next 1 */
  blockstore = blockstore || new Blockstore()
  const { root: cid, out } = await pack({ input, blockstore, wrapWithDirectory, rawLeaves: false, cidVersion: 0 })
  const car = new BlockstoreCarReader(1, [cid], blockstore)
  return { cid, carReader: car, car: out }
}

/**
 * Convert the passed blob to an "import candidate" - an object suitable for
 * passing to the ipfs-unixfs-importer. Note: content is an accessor so that
 * the stream is created only when needed.
 *
 * @param {string} path
 * @param {Pick<Blob, 'stream'>|{ stream: () => AsyncIterable<Uint8Array> }} blob
 * @returns {import('ipfs-core-types/src/utils.js').ImportCandidate}
 */
function toImportCandidate(path, blob) {
  /** @type {AsyncIterable<Uint8Array>} */
  let stream
  return {
    path,
    get content() {
      stream = stream || blob.stream()
      return stream
    },
  }
}

export { FilebaseClient, File, Blob, FormData, toGatewayURL, Token }
