/* 
 =========================================================================
 == upscaler-worker.js (V5 - 最终版，适配跨域隔离环境)
 =========================================================================
*/
console.log('[WORKER] ONNX.js Worker 脚本启动');

// 【新增】检查当前是否处于跨域隔离状态
// self.crossOriginIsolated 在 Worker 中可以直接访问
console.log(`[WORKER] 环境状态: crossOriginIsolated = ${self.crossOriginIsolated}`);
if (!self.crossOriginIsolated) {
    console.warn('[WORKER] 警告: 当前环境未开启跨域隔离 (cross-origin isolation)。多线程和高内存模式将不可用，可能导致复杂模型运行失败。');
    // 可以在这里向主线程发送一个警告
    self.postMessage({ type: 'status', payload: { message: '警告: 环境未隔离，性能受限' } });
}

try {
    self.importScripts("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.js");

    ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
    
    // 只有在隔离环境下才启用多线程，否则让ONNX自动回退
    if (self.crossOriginIsolated) {
        ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;
        console.log(`[WORKER] 已启用多线程，线程数: ${ort.env.wasm.numThreads}`);
    } else {
        console.log('[WORKER] 未启用多线程。');
    }

    // 内存限制依然设置，它在单线程下也有帮助，但在隔离环境下效果最好
    ort.env.wasm.memoryLimit = 512 * 1024 * 1024; 
    console.log(`[WORKER] ONNX WASM memory limit set to ${ort.env.wasm.memoryLimit / 1024 / 1024} MB`);
    
    self.postMessage({ type: 'status', payload: { message: 'AI环境初始化成功，等待任务...' } });

} catch (e) {
    console.error('[WORKER] 导入或配置ONNX脚本失败:', e);
    self.postMessage({ type: 'error', payload: { message: '无法加载或配置ONNX.js核心库。', stack: e.stack } });
}


// --- 后续所有代码 (modelCache, onmessage, createImageDataFromFile, loadModel 等) 保持不变 ---
// --- 您可以继续使用上一个版本 (V4) 的那部分代码，无需修改 ---

let modelCache = {};

self.onmessage = async (event) => {
    const { type, file, config } = event.data;
    if (type === 'start') {
        try {
            self.postMessage({ type: 'status', payload: { message: '正在解码图片...' } });
            const imageData = await createImageDataFromFile(file);

            self.postMessage({ type: 'status', payload: { message: '开始放大流程...' } });
            const resultImageData = await upscaleImage(imageData, config);
            
            self.postMessage({ type: 'done', payload: { data: resultImageData.data.buffer, width: resultImageData.width, height: resultImageData.height } }, [resultImageData.data.buffer]);
        } catch (error) {
            console.error('[WORKER] 任务执行期间发生错误:', error);
            const errorMessage = (error && error.message) ? error.message : String(error);
            const errorStack = (error && error.stack) ? error.stack : 'No stack available.';
            self.postMessage({ type: 'error', payload: { message: errorMessage, stack: errorStack } });
        }
    }
};

async function createImageDataFromFile(file) {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return ctx.getImageData(0, 0, width, height);
}

async function loadModel(modelPath) {
    if (modelCache[modelPath]) {
        return modelCache[modelPath];
    }
    
    const modelFile = modelPath.split('/').pop();
    self.postMessage({ type: 'status', payload: { message: `请求模型: ${modelFile}` } });

    try {
        const response = await fetch(modelPath); 
        
        if (!response.ok) {
            throw new Error(`模型文件加载失败: ${response.status} ${response.statusText}。请检查路径 '${modelPath}' 是否正确。`);
        }

        const modelBuffer = await response.arrayBuffer();
        
        self.postMessage({ type: 'status', payload: { message: `正在创建AI会话...` } });
        
        const session = await ort.InferenceSession.create(modelBuffer, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all'
        });

        modelCache[modelPath] = session;
        return session;
    } catch (e) {
        console.error(`[WORKER] 加载模型时出错 ${modelPath}:`, e);
        throw e;
    }
}


async function upscaleImage(imageData, config) {
    let currentTensorData = imageDataToFloat32(imageData);
    let currentWidth = imageData.width;
    let currentHeight = imageData.height;

    const tasks = getWaifu2xTasks(config);
    console.log(`[WORKER] 生成的任务列表:`, tasks);

    if (tasks.length === 0) {
         self.postMessage({ type: 'status', payload: { message: '无需处理，返回原图。' } });
         return imageData;
    }

    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const taskName = `${i + 1}/${tasks.length} (${task.modelPath.split('/').pop()})`;
        const model = await loadModel(task.modelPath);
        const { outputData, outputWidth, outputHeight } = await processWithModel(
            currentTensorData, currentWidth, currentHeight, model, config.patchSize, task.scale, taskName
        );
        currentTensorData = outputData;
        currentWidth = outputWidth;
        currentHeight = outputHeight;
    }

    return float32ToImageData(currentTensorData, currentWidth, currentHeight);
}
async function processWithModel(inputData, width, height, model, patchSize, scale, taskName) {
    const outputWidth = width * scale;
    const outputHeight = height * scale;
    const outputData = new Float32Array(3 * outputWidth * outputHeight);
    const tilesX = Math.ceil(width / patchSize);
    const tilesY = Math.ceil(height / patchSize);
    const totalTiles = tilesX * tilesY;
    let processedTiles = 0;
    let startTime = performance.now();
    self.postMessage({ type: 'progress', payload: { progress: 0, eta: 0, task: taskName } });
    for (let y = 0; y < tilesY; y++) {
        for (let x = 0; x < tilesX; x++) {
            const xStart = x * patchSize;
            const yStart = y * patchSize;
            const tileW = Math.min(patchSize, width - xStart);
            const tileH = Math.min(patchSize, height - yStart);
            const patchData = extractPatch(inputData, width, height, xStart, yStart, tileW, tileH);
            const inputTensor = new ort.Tensor('float32', patchData, [1, 3, tileH, tileW]);
            const feeds = { [model.inputNames[0]]: inputTensor };
            const results = await model.run(feeds);
            const outputPatchTensor = results[model.outputNames[0]];
            composePatch(outputData, outputWidth, outputHeight, xStart * scale, yStart * scale, outputPatchTensor.data, tileW * scale, tileH * scale);
            processedTiles++;
            const progress = processedTiles / totalTiles;
            const elapsed = (performance.now() - startTime) / 1000;
            const eta = progress > 0.01 ? (elapsed / progress) * (1 - progress) : 0;
            if (processedTiles % 5 === 0 || progress === 1) { 
                self.postMessage({ type: 'progress', payload: { progress, eta, task: taskName } });
            }
        }
    }
    return { outputData, outputWidth, outputHeight };
}
function imageDataToFloat32(imageData) {
    const { data, width, height } = imageData;
    const float32Data = new Float32Array(3 * width * height);
    const planeSize = width * height;
    for (let i = 0; i < planeSize; i++) {
        const j = i * 4;
        float32Data[i] = data[j] / 255.0;
        float32Data[i + planeSize] = data[j + 1] / 255.0;
        float32Data[i + 2 * planeSize] = data[j + 2] / 255.0;
    }
    return float32Data;
}
function float32ToImageData(float32Data, width, height) {
    const count = width * height;
    const planeSize = count;
    const imageData = new ImageData(width, height);
    const data = imageData.data;
    for (let i = 0; i < count; i++) {
        const i4 = i * 4;
        data[i4] = Math.max(0, Math.min(255, float32Data[i] * 255));
        data[i4 + 1] = Math.max(0, Math.min(255, float32Data[i + planeSize] * 255));
        data[i4 + 2] = Math.max(0, Math.min(255, float32Data[i + 2 * planeSize] * 255));
        data[i4 + 3] = 255;
    }
    return imageData;
}
function extractPatch(source, sourceW, sourceH, x, y, w, h) {
    const patch = new Float32Array(3 * w * h);
    const sourcePlaneSize = sourceW * sourceH;
    const patchPlaneSize = w * h;
    for (let c = 0; c < 3; c++) {
        const sourceOffset = c * sourcePlaneSize;
        const patchOffset = c * patchPlaneSize;
        for (let py = 0; py < h; py++) {
            const sourceRowStart = sourceOffset + (y + py) * sourceW;
            const patchRowStart = patchOffset + py * w;
            patch.set(source.subarray(sourceRowStart + x, sourceRowStart + x + w), patchRowStart);
        }
    }
    return patch;
}
function composePatch(target, targetW, targetH, x, y, patch, w, h) {
    const targetPlaneSize = targetW * targetH;
    const patchPlaneSize = w * h;
    for (let c = 0; c < 3; c++) {
        const targetOffset = c * targetPlaneSize;
        const patchOffset = c * patchPlaneSize;
        for (let py = 0; py < h; py++) {
            const targetY = y + py;
            if (targetY >= targetH) continue;
            const targetRowStart = targetOffset + targetY * targetW;
            const patchRowStart = patchOffset + py * w;
            const length = Math.min(w, targetW - x);
            if (length <= 0) continue;
            target.set(patch.subarray(patchRowStart, patchRowStart + w).subarray(0, length), targetRowStart + x);
        }
    }
}
function getWaifu2xTasks(config) {
    const { arch, style, noise, scale } = config.waifu2x;
    if (scale === 1 && noise === '0') return [];
    const effectiveStyle = (arch === 'cunet') ? 'art' : style;
    const basePath = `./models/waifu2x/${arch}/${effectiveStyle}/`;
    let tasks = [];
    if (arch === 'swin_unet') {
        if (noise !== '0') tasks.push({ modelPath: `${basePath}noise${noise}.onnx`, scale: 1 });
        if (scale > 1) tasks.push({ modelPath: `${basePath}scale${scale}x.onnx`, scale: scale });
    } else if (arch === 'cunet') {
        let modelName = (noise === '0') ? `scale2x.onnx` : `noise${noise}_scale2x.onnx`;
        tasks.push({ modelPath: basePath + modelName, scale: 2 });
    }
    return tasks;
}