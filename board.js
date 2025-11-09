async swapCandies(candy1, candy2, noDelay = false) {
    const r1 = parseInt(candy1.dataset.row);
    const c1 = parseInt(candy1.dataset.col);
    const r2 = parseInt(candy2.dataset.row);

    // Find all candies of the target type
    for (let r = 0; r < this.size; r++) {
        for (let c = 0; c < this.size; c++) {
            const candy = this.grid[r][c];
            if (candy && candy.dataset.type === targetType) {
                candiesToRemove.add(candy);
            }
        }
    }

    if (candiesToRemove.size > 0) {
        this.onMatch(Array.from(candiesToRemove), true);
        playSound('sweet_mash.mp3');
        recorder.recordSound('sweet_mash.mp3');
        
        candiesToRemove.forEach(candy => {
            if (candy) {
                candy.classList.add('matched');
                this.grid[parseInt(candy.dataset.row)][parseInt(candy.dataset.col)] = null;
            }
        });
    }

    if (!noDelay) await this.pausableTimeout(300);

    candiesToRemove.forEach(candy => {
        if (candy) candy.remove()
    });

    await this.dropCandies(noDelay);
    await this.fillBoard(false, noDelay);

    await this.processMatches(false, null, noDelay);
}