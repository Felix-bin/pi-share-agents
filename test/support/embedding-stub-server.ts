import * as http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A real `node:http` server standing in for the SiliconFlow embeddings API.
 *
 * The embedder under test must go through a genuine HTTP round trip — module
 * mocking is banned by the repo's anti-slop rules — so tests point
 * `synapse.embedding.endpoint` at this loopback server. Every request is
 * captured verbatim for assertions on the wire format.
 */

export type CapturedRequest = {
	auth: string | undefined;
	body: string;
	contentType: string | undefined;
};

export type StubResponseOptions = {
	promptTokens?: number;
};

export type StubEmbeddingHandler = (request: CapturedRequest, response: http.ServerResponse) => void;

export type StubEmbeddingServer = {
	close: () => Promise<void>;
	/** Replace the active responder; `respondWithVector` sets this for the happy path. */
	setHandler: (handler: StubEmbeddingHandler) => void;
	requests: CapturedRequest[];
	respondWithVector: (values: readonly number[], options?: StubResponseOptions) => void;
	/** Like respondWithVector, but each input text gets its own vector. */
	respondWithVectorForInput: (resolve: (input: string) => readonly number[], options?: StubResponseOptions) => void;
	/** The same, in the JSON-number wire shape an ordinary gateway returns. */
	respondWithJsonVectorForInput: (resolve: (input: string) => readonly number[], options?: StubResponseOptions) => void;
	port: number;
	server: http.Server;
};

function encodeFloat32LEBase64(values: readonly number[]): string {
	const buffer = Buffer.alloc(values.length * 4);
	for (const [index, value] of values.entries()) {
		buffer.writeFloatLE(value, index * 4);
	}
	return buffer.toString("base64");
}

export async function startEmbeddingStub(): Promise<StubEmbeddingServer> {
	const requests: CapturedRequest[] = [];
	const state = {
		handler: (_request: CapturedRequest, response: http.ServerResponse) => {
			response.statusCode = 500;
			response.end("stub handler not configured");
		},
	} satisfies { handler: StubEmbeddingHandler };
	const server = http.createServer((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf-8");
		});
		request.on("end", () => {
			const captured: CapturedRequest = {
				auth: request.headers.authorization,
				body,
				contentType: request.headers["content-type"],
			};
			requests.push(captured);
			state.handler(captured, response);
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	// SAFETY: the server is listening on a loopback TCP port, so address() returns AddressInfo.
	const address = server.address() as AddressInfo;
	const port = address.port;
	return {
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
		port,
		requests,
		respondWithVector(values: readonly number[], options: StubResponseOptions = {}) {
			const embedding = encodeFloat32LEBase64(values);
			state.handler = (request, response) => {
				// SAFETY: the request body is JSON this stub's counterpart (the embedder under test) serialized.
				const parsed = JSON.parse(request.body) as { input: string | readonly string[] };
				const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
				response.statusCode = 200;
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						data: inputs.map((_text, index) => ({ embedding, index })),
						model: "BAAI/bge-m3",
						object: "list",
						usage: options.promptTokens === undefined ? undefined : { prompt_tokens: options.promptTokens, total_tokens: options.promptTokens },
					}),
				);
			};
		},
		respondWithVectorForInput(resolve: (input: string) => readonly number[], options: StubResponseOptions = {}) {
			state.handler = (request, response) => {
				// SAFETY: the request body is JSON this stub's counterpart (the embedder under test) serialized.
				const parsed = JSON.parse(request.body) as { input: string | readonly string[] };
				const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
				response.statusCode = 200;
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						data: inputs.map((text, index) => ({ embedding: encodeFloat32LEBase64(resolve(text)), index })),
						model: "BAAI/bge-m3",
						object: "list",
						usage: options.promptTokens === undefined ? undefined : { prompt_tokens: options.promptTokens, total_tokens: options.promptTokens },
					}),
				);
			};
		},
		server,
		/**
		 * The wire shape of an ordinary OpenAI-compatible gateway: an array of JSON
		 * numbers, whatever `encoding_format` the request asked for. Modelling that
		 * indifference is the point — a client that assumes it is obeyed would decode
		 * these numbers as base64.
		 */
		respondWithJsonVectorForInput(resolve: (input: string) => readonly number[], options: StubResponseOptions = {}) {
			state.handler = (request, response) => {
				// SAFETY: the request body is JSON this stub's counterpart (the embedder under test) serialized.
				const parsed = JSON.parse(request.body) as { input: string | readonly string[] };
				const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
				response.statusCode = 200;
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						data: inputs.map((text, index) => ({ embedding: [...resolve(text)], index })),
						model: "GLM-Embedding-3",
						object: "list",
						usage: options.promptTokens === undefined ? undefined : { prompt_tokens: options.promptTokens, total_tokens: options.promptTokens },
					}),
				);
			};
		},
		setHandler: (handler) => {
			state.handler = handler;
		},
	};
}
