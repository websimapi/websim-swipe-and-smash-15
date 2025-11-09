import Board from './board.js';
import * as recorder from './recorder.js';
import { playSound, playBackgroundMusic } from './audio.js';

export default class Replay {
    constructor(game, config) {
        this.game = game;
        this.config = config;
        this.replayTimeouts = [];
        this.replayBgmControl = null;
        this.controlsTimeout = null;
        this.timelineUpdateId = null;
        this.isScrubbing = false;

        this.state = {
            isPlaying: false,
            isPaused: false,
            pauseTime: 0,
            startTime: 0,
            actions: [],
            currentReplayBoard: null,
            duration: 0,
            initialState: null,
        };

        this.setupUI();
    }

    setupUI() {
        document.getElementById('clip-button').addEventListener('click', () => this.show());
        document.getElementById('close-replay-button').addEventListener('click', () => this.hide());
        document.getElementById('replay-container').addEventListener('click', () => this.handleContainerClick());
        
        const timelineContainer = document.getElementById('replay-timeline-container');
        timelineContainer.addEventListener('pointerdown', this.handleScrubStart.bind(this));
    }

    handleScrubStart(e) {
        e.preventDefault();
        this.isScrubbing = true;
        
        if (this.state.isPlaying && !this.state.isPaused) {
            this.pause(true); // Soft pause without showing play icon
        }

        const timelineRect = e.currentTarget.getBoundingClientRect();
        const progress = (e.clientX - timelineRect.left) / timelineRect.width;
        const seekTime = Math.max(0, this.state.duration * progress);

        this.seek(seekTime);

        const handleScrubMove = (moveEvent) => {
            if (!this.isScrubbing) return;
            const moveProgress = (moveEvent.clientX - timelineRect.left) / timelineRect.width;
            const moveSeekTime = Math.max(0, Math.min(this.state.duration, this.state.duration * moveProgress));
            this.seek(moveSeekTime);
        };

        const handleScrubEnd = () => {
            this.isScrubbing = false;
            document.removeEventListener('pointermove', handleScrubMove);
            document.removeEventListener('pointerup', handleScrubEnd);
            
            // If the video was playing before scrubbing, resume it.
            if (this.state.isPlaying && this.state.isPaused) {
                this.resume();
            }
        };

        document.addEventListener('pointermove', handleScrubMove);
        document.addEventListener('pointerup', handleScrubEnd);
    }

    handleContainerClick() {
        if (!this.state.isPlaying || this.isScrubbing) return;

        if (this.state.isPaused) {
            this.resume();
        } else {
            this.pause();
        }
    }

    showControls() {
        const playPauseButton = document.getElementById('play-pause-button');
        playPauseButton.classList.add('visible');
        clearTimeout(this.controlsTimeout);
        this.controlsTimeout = setTimeout(() => {
            playPauseButton.classList.remove('visible');
        }, 1000);
    }
    
    show() {
        this.game.pauseTimer();
        this.game.pauseMainBGM();
        if (this.game.isRecordingStarted) {
            recorder.pauseRecording();
        }
        const modal = document.getElementById('replay-modal');
        modal.classList.remove('hidden');
        this.play();
    }

    hide() {
        const modal = document.getElementById('replay-modal');
        modal.classList.add('hidden');
        this.stop(); // Use stop to properly clean up

        // Force cleanup of any lingering replay candy elements
        const lingeringCandies = document.querySelectorAll('.replay-candy');
        lingeringCandies.forEach(candy => candy.remove());

        if (this.game.isRecordingStarted) {
            recorder.resumeRecording();
        }
        this.game.resumeMainBGM();
        this.game.resumeTimer();
    }

    async play() {
        const playPauseButton = document.getElementById('play-pause-button');

        const recording = recorder.getRecording();
        if (!recording || !recording.initialState) return;

        this.replayTimeouts.forEach(clearTimeout);
        this.replayTimeouts = [];

        const replayBoardElement = document.getElementById('replay-board');
        replayBoardElement.innerHTML = ''; // Clear previous replay

        const candyQueue = recording.actions.filter(a => a.type === 'newCandy').map(a => a.candyType);
        const replayTypeGenerator = () => {
            const nextType = candyQueue.shift();
            // Fallback, though it shouldn't be needed with proper recording.
            return nextType || this.config.candyTypes[0];
        };

        const replayBoard = new Board(this.config.boardSize, this.config.candyTypes, () => {}, replayTypeGenerator, () => this.state.isPaused);
        replayBoard.boardElement = replayBoardElement;
        replayBoard.setupBoard();

        // Override functions for replay board to tag candies
        replayBoard.createCandy = function(row, col, type, isInitializing = false) {
            return Board.prototype.createCandy.call(this, row, col, type, isInitializing, true);
        };
        replayBoard.fillBoard = function() {
            return Board.prototype.fillBoard.call(this, true);
        };

        replayBoard.initialize(recording.initialState);

        this.state.initialState = recording.initialState;
        this.state.duration = recording.actions.length > 0 ? recording.actions[recording.actions.length - 1].timestamp : 0;
        this.state.isPlaying = true;
        this.state.isPaused = false;
        this.state.startTime = performance.now();
        this.state.actions = [...recording.actions];
        this.state.currentReplayBoard = replayBoard; // Store for resume
        playPauseButton.innerHTML = '&#10074;&#10074;'; // Pause icon
        playPauseButton.classList.remove('playing');
        
        this.showControls(); // Show controls for 1 second at the start

        this.scheduleActions(replayBoard);
        this.startTimelineUpdater();
    }

    scheduleActions(replayBoard, resumeFromTime = 0) {
        this.replayTimeouts.forEach(clearTimeout);
        this.replayTimeouts = [];

        this.state.actions.forEach(action => {
            if (action.timestamp < resumeFromTime) {
                return; // Skip actions that have already passed
            }

            const delay = action.timestamp - resumeFromTime;

            const timeoutId = setTimeout(async () => {
                if (this.state.isPaused || this.isScrubbing) return;

                if (action.type === 'swap') {
                    const candy1 = replayBoard.grid[action.from.r][action.from.c];
                    const candy2 = replayBoard.grid[action.to.r][action.to.c];
                    if(candy1 && candy2) {
                        await replayBoard.swapCandies(candy1, candy2);
                        const isValid = await replayBoard.processMatches(false, [candy1, candy2]);
                        if(!isValid) {
                             await replayBoard.swapCandies(candy1, candy2);
                        }
                    }
                } else if (action.type === 'activateRainbow') {
                    const rainbowCandy = replayBoard.grid[action.rainbowCandy.r][action.rainbowCandy.c];
                    const otherCandy = replayBoard.grid[action.otherCandy.r][action.otherCandy.c];
                    if (rainbowCandy && otherCandy) {
                        await replayBoard.activateRainbowPowerup(rainbowCandy, otherCandy);
                    }
                } else if (action.type === 'smash') {
                    const candiesToSmash = action.smashed
                        .map(coords => (replayBoard.grid[coords.r] ? replayBoard.grid[coords.r][coords.c] : null))
                        .filter(Boolean);
                    if (candiesToSmash.length > 0) {
                        await replayBoard.smashCandies(candiesToSmash);
                    }
                } else if (action.type === 'initialCascade') {
                    await replayBoard.processMatches(false, null);
                } else if (action.type === 'sound') {
                    playSound(action.name);
                } else if (action.type === 'startRainbow') {
                    document.getElementById('replay-board').parentElement.classList.add('rainbow-mode');
                } else if (action.type === 'endRainbow') {
                    document.getElementById('replay-board').parentElement.classList.remove('rainbow-mode');
                } else if (action.type === 'startBGM' && !this.replayBgmControl) {
                    this.replayBgmControl = await playBackgroundMusic(true);
                }
            }, delay);

            this.replayTimeouts.push(timeoutId);
        });

        const recordingDuration = this.state.actions.length > 0 ? this.state.actions[this.state.actions.length - 1].timestamp : 0;
        const endTimeout = setTimeout(() => {
            if (!this.state.isPaused) {
                this.hide(); // Hide modal when replay finishes
            }
        }, recordingDuration - resumeFromTime + 2000); // 2 seconds after last action
        this.replayTimeouts.push(endTimeout);
    }

    togglePlayback() {
        if (this.state.isPlaying) {
            if (this.state.isPaused) {
                this.resume();
            } else {
                this.pause();
            }
        }
    }

    pause(soft = false) {
        if (!this.state.isPlaying || this.state.isPaused) return;

        this.replayTimeouts.forEach(clearTimeout);
        this.replayTimeouts = [];
        this.state.isPaused = true;
        this.state.pauseTime = performance.now() - this.state.startTime;
        if (this.replayBgmControl && this.replayBgmControl.pause) {
            this.replayBgmControl.pause();
        }
        
        if (!soft) {
            clearTimeout(this.controlsTimeout);
            const playPauseButton = document.getElementById('play-pause-button');
            playPauseButton.innerHTML = '&#9658;'; // Play icon
            playPauseButton.classList.add('visible');
        }
    }

    resume() {
        if (!this.state.isPaused) return;

        this.state.isPaused = false;
        this.state.startTime = performance.now() - this.state.pauseTime;

        if (this.replayBgmControl && this.replayBgmControl.resume) {
            this.replayBgmControl.resume();
        }
        
        this.scheduleActions(this.state.currentReplayBoard, this.state.pauseTime);

        const playPauseButton = document.getElementById('play-pause-button');
        playPauseButton.innerHTML = '&#10074;&#10074;'; // Pause icon
        playPauseButton.classList.remove('visible');
    }

    stop() {
        this.replayTimeouts.forEach(clearTimeout);
        this.replayTimeouts = [];
        if (this.replayBgmControl) {
            this.replayBgmControl.stop();
            this.replayBgmControl = null;
        }
        cancelAnimationFrame(this.timelineUpdateId);
        this.timelineUpdateId = null;
        clearTimeout(this.controlsTimeout);
        this.state = { isPlaying: false, isPaused: false, pauseTime: 0, startTime: 0, actions: [], currentReplayBoard: null, duration: 0, initialState: null };

        const playPauseButton = document.getElementById('play-pause-button');
        playPauseButton.innerHTML = '&#9658;'; // Play icon
        playPauseButton.classList.remove('visible');
        this.updateTimelineUI(0); // Reset timeline on stop
    }

    async seek(time) {
        // Update state and UI immediately
        this.state.pauseTime = time;
        this.state.startTime = performance.now() - time;
        this.updateTimelineUI(time / this.state.duration);
    
        // Rebuild the board state up to the seek time
        const replayBoardElement = document.getElementById('replay-board');
        replayBoardElement.innerHTML = '';
    
        const candyQueue = recorder.getRecording().actions.filter(a => a.type === 'newCandy').map(a => a.candyType);
        const replayTypeGenerator = () => candyQueue.shift() || this.config.candyTypes[0];
    
        const replayBoard = new Board(this.config.boardSize, this.config.candyTypes, () => {}, replayTypeGenerator, () => this.state.isPaused);
        replayBoard.boardElement = replayBoardElement;
        replayBoard.setupBoard();
        replayBoard.createCandy = function(r, c, t, i) { return Board.prototype.createCandy.call(this, r, c, t, i, true); };
        replayBoard.fillBoard = function() { return Board.prototype.fillBoard.call(this, true); };
        replayBoard.initialize(this.state.initialState);
        this.state.currentReplayBoard = replayBoard;

        replayBoard.boardElement.parentElement.classList.remove('rainbow-mode');
    
        // Process all actions up to the seek time without delays
        for (const action of this.state.actions) {
            if (action.timestamp > time) break;

            if (action.type === 'swap') {
                const candy1 = replayBoard.grid[action.from.r][action.from.c];
                const candy2 = replayBoard.grid[action.to.r][action.to.c];
                if(candy1 && candy2) {
                    await replayBoard.swapCandies(candy1, candy2, true);
                    const isValid = await replayBoard.processMatches(false, [candy1, candy2], true);
                    if(!isValid) {
                         await replayBoard.swapCandies(candy1, candy2, true);
                    }
                }
            } else if (action.type === 'activateRainbow') {
                const rainbowCandy = replayBoard.grid[action.rainbowCandy.r][action.rainbowCandy.c];
                const otherCandy = replayBoard.grid[action.otherCandy.r][action.otherCandy.c];
                if (rainbowCandy && otherCandy) {
                    await replayBoard.activateRainbowPowerup(rainbowCandy, otherCandy, true);
                }
            } else if (action.type === 'smash') {
                const candiesToSmash = action.smashed
                    .map(coords => (replayBoard.grid[coords.r] ? replayBoard.grid[coords.r][coords.c] : null))
                    .filter(Boolean);
                if (candiesToSmash.length > 0) {
                    await replayBoard.smashCandies(candiesToSmash, true);
                }
            } else if (action.type === 'initialCascade') {
                await replayBoard.processMatches(false, null, true);
            } else if (action.type === 'startRainbow') {
                 replayBoard.boardElement.parentElement.classList.add('rainbow-mode');
            } else if (action.type === 'endRainbow') {
                replayBoard.boardElement.parentElement.classList.remove('rainbow-mode');
            }
        }
        
        // Clear any remaining timeouts from previous plays
        this.replayTimeouts.forEach(clearTimeout);
        this.replayTimeouts = [];

        // If we were playing, schedule the remaining actions
        if (!this.state.isPaused) {
            this.scheduleActions(replayBoard, time);
        }
    }

    startTimelineUpdater() {
        const update = () => {
            if (!this.state.isPlaying || this.state.duration === 0) {
                this.timelineUpdateId = null;
                return;
            }
    
            if (!this.state.isPaused && !this.isScrubbing) {
                const currentTime = performance.now() - this.state.startTime;
                const progress = Math.min(1, currentTime / this.state.duration);
                this.updateTimelineUI(progress);
            }
            
            this.timelineUpdateId = requestAnimationFrame(update);
        };
        
        cancelAnimationFrame(this.timelineUpdateId);
        this.timelineUpdateId = requestAnimationFrame(update);
    }
    
    updateTimelineUI(progress) {
        const progressElement = document.getElementById('replay-timeline-progress');
        const handleElement = document.getElementById('replay-timeline-handle');
        if (progressElement && handleElement) {
            progressElement.style.width = `${progress * 100}%`;
            handleElement.style.left = `${progress * 100}%`;
        }
    }
}