#!/bin/bash
# 결 질의 24편을 4건씩 GPT 로 (gpt-ask.js 가 동시 4건을 지킨다)
cd D:/midform
run(){ v=$1; [ -s reference/gyeol_corp/gpt/a_$v.md ] && return; node scripts/gpt-ask.js --session "기업흥망 결" --effort medium --no-search --file reference/gyeol_corp/gpt/q_$v.md > reference/gyeol_corp/gpt/a_$v.md 2> reference/gyeol_corp/gpt/a_$v.err; echo "$v $?"; }
export -f run
ls reference/gyeol_corp/gpt/q_*.md | sed 's/.*q_//;s/\.md$//' | xargs -P 4 -I{} bash -c 'run {}'
