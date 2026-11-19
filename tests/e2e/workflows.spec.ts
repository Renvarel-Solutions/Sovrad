import {test, expect, post} from './fixtures';
import type {WorkflowDetailResponse} from '@renvarel/architect-core';

test.beforeEach(async ({request}) => {
  await post(request,'/api/workspace/access',{mode:'all_connected',selectedProjectIds:[]});
});

test('navigation sample uses connected React Flow, child stages and Back restores selection and viewport', async ({page}) => {
  const errors:string[] = [];
  page.on('pageerror',error => errors.push(error.message));
  await page.goto('/');
  await page.locator('.sidebar').getByRole('button',{name:'Workflow navigation (fictional sample)',exact:true}).click();
  await page.getByRole('button',{name:'Open Review input',exact:true}).click();
  await page.locator('.react-flow__node').filter({hasText:'Review input'}).click();
  await expect(page.locator('.react-flow__controls')).toBeVisible();
  await expect(page.locator('.react-flow__minimap')).toBeVisible();
  const minimapNodes=page.locator('.react-flow__minimap-node');
  await expect(minimapNodes).toHaveCount(3);
  for(const node of await minimapNodes.all()){
    expect(Number(await node.getAttribute('width'))).toBeGreaterThan(0);
    expect(Number(await node.getAttribute('height'))).toBeGreaterThan(0);
  }
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);
  await expect(page.locator('.react-flow__edge-text')).toContainText(['Valid','Invalid','Try again']);
  await expect(page.locator('.inspector')).toContainText('Not yet checked');
  await expect(page.locator('.inspector')).toContainText('Acceptance evidence is not available yet.');
  await page.getByLabel('What should change?',{exact:true}).fill('Preserve this review draft.');
  await page.locator('.react-flow__controls-zoomin').click();
  const viewport = await page.locator('.react-flow__viewport').getAttribute('style');
  await page.getByRole('button',{name:'Open child workflow',exact:true}).click();
  await page.locator('.react-flow__node').filter({hasText:'Check format'}).click();
  await expect(page.getByRole('heading',{name:'Check format',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Back to Review input',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Review input',exact:true})).toBeVisible();
  await expect(page.locator('.step-node-active')).toContainText('Review input');
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style',viewport!);
  await expect(page.getByLabel('What should change?',{exact:true})).toHaveValue('Preserve this review draft.');
  await page.getByRole('button',{name:'List view',exact:true}).click();
  await page.getByRole('button',{name:'Select Explain correction',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Explain correction',exact:true})).toBeVisible();
  await expect(page.locator('.inspector')).toContainText('Inputs');
  await expect(page.locator('.inspector')).toContainText('Outputs');
  await expect(page.locator('.exception')).toContainText('Explain the correction and retain the input.');
  await expect(page.getByRole('button',{name:/Edit (connections|topology)/i})).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('390px uses an accessible stage list and complete rules inputs outputs exceptions', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');
  await page.locator('.sidebar').getByRole('button',{name:'Workflow navigation (fictional sample)',exact:true}).click();
  await page.getByRole('button',{name:'Open Review input',exact:true}).click();
  const review = page.getByRole('button',{name:'Select Review input',exact:true});
  await expect(review).toBeVisible();
  await review.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading',{name:'Review input',exact:true})).toBeVisible();
  await expect(page.locator('.inspector')).toContainText('Inputs');
  await expect(page.locator('.inspector')).toContainText('Outputs');
  await expect(page.locator('.rules-list')).toContainText('Review the plan before acting.');
  await expect(page.locator('.exception')).toContainText('Explain the correction and retain the input.');
  await expect(page.locator('.inspector')).toContainText('Not yet checked');
  await page.getByRole('button',{name:'Open child workflow',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Check format',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Back to Review input',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Review input',exact:true})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('review: live saved layout reversal retains all connections draft selection and viewport', async ({page,request}) => {
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');
  await page.locator('.sidebar').getByRole('button',{name:'Workflow navigation (fictional sample)',exact:true}).click();
  await page.getByRole('button',{name:'Open Review input',exact:true}).click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);
  await expect(page.locator('.react-flow__minimap-node')).toHaveCount(3);
  await page.locator('.react-flow__node').filter({hasText:'Explain correction'}).click();
  await expect(page.getByRole('heading',{name:'Explain correction',exact:true})).toBeVisible();
  await page.getByLabel('What should change?',{exact:true}).fill('Keep this draft while the saved layout changes.');
  await page.locator('.react-flow__controls-zoomin').click();
  const viewport=await page.locator('.react-flow__viewport').getAttribute('style');
  const response=await request.get('/api/workflows/sample-navigation-main');
  expect(response.ok()).toBe(true);
  const detail:WorkflowDetailResponse=await response.json();
  const positions=detail.workflow.steps.map(step=>({
    stepId:step.id,...(detail.layout.positions.find(position=>position.stepId===step.id)??step.position),
  }));
  const nextX=Math.max(...positions.filter(position=>position.stepId!=='review-input').map(position=>position.x))+360;
  await post(request,'/api/workflows/sample-navigation-main/layout',{
    expectedLayoutRevision:detail.layout.layoutRevision,
    positions:positions.map(position=>position.stepId==='review-input'?{...position,x:nextX}:position),
  });
  // Wait for the existing detail poll, without remounting or reloading the page.
  await expect.poll(async()=>page.locator('.react-flow__node[data-id="review-input"]').evaluate(element=>
    new DOMMatrixReadOnly(getComputedStyle(element).transform).m41),{timeout:20000}).toBe(nextX);
  // This edge was forward before the refresh; its new presentation requires the newly mounted return handles.
  await expect(page.locator('.react-flow__edge[data-id="review-valid"]')).toHaveClass(/react-flow__edge-smoothstep/);
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);
  await expect(page.locator('.react-flow__edge-text')).toContainText(['Valid','Invalid','Try again']);
  await expect(page.locator('.react-flow__minimap-node')).toHaveCount(3);
  await expect(page.getByRole('heading',{name:'Explain correction',exact:true})).toBeVisible();
  await expect(page.locator('.step-node-active')).toContainText('Explain correction');
  await expect(page.getByLabel('What should change?',{exact:true})).toHaveValue('Keep this draft while the saved layout changes.');
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style',viewport!);
  expect(errors).toEqual([]);
});
