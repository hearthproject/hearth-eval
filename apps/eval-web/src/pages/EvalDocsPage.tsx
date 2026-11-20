export function EvalDocsPage() {
  return (
    <article className="eval-docs">
      <h1>Hearth Eval 如何验收交付</h1>
      <p>交付验收从任务要求出发，检查实际产物，并为每项结论记录依据。具体通过条件由任务决定。</p>
      <h2>工具如何检查订单 CSV？</h2>
      <p>假设任务要求按订单号去重，并移除无效金额。验收时读取清洗后的 CSV，检查订单号是否唯一、金额是否为大于零的十进制数。如果订单 1007 仍出现两次，这个订单号就是去重失败的证据。</p>
      <p>保留原文件是另一项要求。执行前后的文件哈希一致，可以支持这一项通过。缺少执行前的哈希时，这一项应标记为「无法判断」。</p>
      <h2>什么时候用模型评委？</h2>
      <p>例如，用户要求 Markdown 总结准确反映任务决策。启用语义评审后，评委可以对照原始要求、选用的共享上下文和交付文本，判断总结是否遗漏或曲解了决策。</p>
      <h2>方法参考</h2>
      <p>Anthropic 将智能体的执行过程、任务结束后的实际结果和评分方法分开讨论。Hearth Eval 的交付验收参考了这一思路。</p>
      <a href="https://www.anthropic.com/research/demystifying-evals-for-ai-agents" target="_blank" rel="noreferrer">Anthropic · Demystifying evals for AI agents ↗</a>
    </article>
  );
}
